import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  TransactionExternalRecovery,
  TransactionMutation,
} from '../../domain/lifecycle/filesystem-transaction.js';
import { AkError } from '../../domain/contracts/ak-error.js';
import type { PreparedTransaction } from './transaction-preparation.js';
import { isSha256, sha256Bytes, sha256File } from './file-hash.js';
import { removeFileDurably } from './durable-file-removal.js';
import {
  assertPortableRelativePath,
  canonicalizeRoot,
  resolveWithinRoot,
} from './path-guard.js';
import { writeRecoveryReceipt, type ExternalRecoveryFailure } from './recovery-receipt.js';
import {
  acquireTransactionRootLocks,
  canonicalizeTransactionRoots,
  releaseTransactionRootLocks,
} from './transaction-root-lock.js';
import { transactionConflict } from './transaction-errors.js';
import {
  loadTransactionSnapshot,
  restoreTransactionSnapshot,
  type SnapshotEntry,
  type TransactionSnapshot,
} from './transaction-snapshot.js';

const JOURNAL_FILE = 'journal.json';
const MAX_JOURNAL_BYTES = 8 * 1024 * 1024;
const JOURNAL_MARKERS = {
  rolling_back: 'journal.rolling-back',
  committed: 'journal.committed',
  rolled_back: 'journal.rolled-back',
} as const;

interface RecoveryOutcome {
  kind: TransactionMutation['kind'];
  root: string;
  relativePath: string;
  afterSha256?: string;
  afterMode?: number;
  afterSize?: number;
  absent?: true;
  temporaryRelativePath?: string;
  displacedRelativePath?: string;
  rollbackTemporaryRelativePath: string;
  rollbackDisplacedRelativePath: string;
}

interface CommitWitness {
  root: string;
  relativePath: string;
  beforeSha256?: string;
  beforeAbsent?: true;
  afterSha256: string;
}

export interface TransactionJournal {
  version: 1;
  state: 'pending' | 'rolling_back' | 'committed' | 'rolled_back';
  transactionId: string;
  snapshotPath: string;
  snapshotSha256: string;
  createdAt: string;
  updatedAt: string;
  roots: string[];
  outcomes: RecoveryOutcome[];
  commitWitness?: CommitWitness;
  externalRecovery?: TransactionExternalRecovery;
  checksumSha256: string;
}

export type InterruptedExternalRecoveryHandler = (
  descriptor: TransactionExternalRecovery,
  direction: 'rollback' | 'commit',
) => Promise<void>;

export interface InterruptedRecoveryHooks {
  afterRollbackPhasePersisted?: () => void | Promise<void>;
  afterRollbackTemporarySync?: (
    mutation: TransactionMutation,
  ) => void | Promise<void>;
  afterRollbackDisplace?: (
    mutation: TransactionMutation,
  ) => void | Promise<void>;
  afterFilesystemRestored?: () => void | Promise<void>;
  afterRollbackArtifactRemoval?: (
    artifact: { root: string; relativePath: string },
  ) => void | Promise<void>;
}

export async function createPendingTransactionJournal(
  snapshotPath: string,
  transactionId: string,
  roots: string[],
  snapshot: TransactionSnapshot,
  prepared: PreparedTransaction,
  externalRecovery?: TransactionExternalRecovery,
): Promise<TransactionJournal> {
  const now = new Date().toISOString();
  const canonicalSnapshotPath = await canonicalizeRoot(snapshotPath);
  const outcomes = recoveryOutcomes(prepared, transactionId);
  const partial: Omit<TransactionJournal, 'checksumSha256'> = {
    version: 1,
    state: 'pending',
    transactionId,
    snapshotPath: canonicalSnapshotPath,
    snapshotSha256: await sha256File(
      path.join(canonicalSnapshotPath, 'snapshot.json'),
    ),
    createdAt: now,
    updatedAt: now,
    roots,
    outcomes,
    ...commitWitness(outcomes, snapshot),
    ...(externalRecovery ? { externalRecovery } : {}),
  };
  const journal: TransactionJournal = withChecksum(partial);
  await writeJournal(snapshotPath, journal);
  return journal;
}

export async function markTransactionJournal(
  snapshotPath: string,
  journal: TransactionJournal,
  state: 'rolling_back' | 'committed' | 'rolled_back',
): Promise<TransactionJournal> {
  await writeJournalMarker(snapshotPath, journal, state);
  return { ...journal, state };
}

export async function recoverInterruptedTransactions(
  snapshotDirectory: string,
  recoveryDirectory: string,
  recoverExternal?: InterruptedExternalRecoveryHandler,
  hooks?: InterruptedRecoveryHooks,
): Promise<string[]> {
  const entries = await fs
    .readdir(snapshotDirectory, { withFileTypes: true })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
  const recovered: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || !entry.name.startsWith('transaction-')) continue;
    const snapshotPath = path.join(snapshotDirectory, entry.name);
    const initial = await loadJournal(snapshotPath);
    if (
      !initial ||
      (initial.state !== 'pending' && initial.state !== 'rolling_back')
    ) {
      continue;
    }
    const roots = await canonicalizeTransactionRoots(initial.roots);
    const releases = await acquireTransactionRootLocks(roots);
    try {
      const journal = await loadJournal(snapshotPath);
      if (
        !journal ||
        (journal.state !== 'pending' && journal.state !== 'rolling_back')
      ) {
        continue;
      }
      await recoverOne(
        snapshotPath,
        journal,
        recoveryDirectory,
        recoverExternal,
        hooks,
      );
      recovered.push(journal.transactionId);
    } finally {
      await releaseTransactionRootLocks(releases);
    }
  }
  return recovered;
}

export async function inspectTransactionJournals(
  snapshotDirectory: string,
): Promise<{
  pending: number;
  committed: number;
  rolledBack: number;
  invalid: number;
}> {
  const summary = { pending: 0, committed: 0, rolledBack: 0, invalid: 0 };
  const entries = await fs
    .readdir(snapshotDirectory, { withFileTypes: true })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('transaction-')) continue;
    try {
      const journal = await loadJournal(path.join(snapshotDirectory, entry.name));
      if (!journal) continue;
      if (journal.state === 'pending' || journal.state === 'rolling_back') {
        summary.pending += 1;
      }
      else if (journal.state === 'committed') summary.committed += 1;
      else summary.rolledBack += 1;
    } catch {
      summary.invalid += 1;
    }
  }
  return summary;
}

async function recoverOne(
  snapshotPath: string,
  initialJournal: TransactionJournal,
  recoveryDirectory: string,
  recoverExternal: InterruptedExternalRecoveryHandler | undefined,
  hooks: InterruptedRecoveryHooks | undefined,
): Promise<void> {
  let journal = initialJournal;
  let snapshot: TransactionSnapshot;
  try {
    snapshot = await loadTransactionSnapshot(snapshotPath);
    if (
      snapshot.transactionId !== journal.transactionId ||
      (await sha256File(path.join(snapshotPath, 'snapshot.json'))) !==
        journal.snapshotSha256
    ) {
      throw new Error('Snapshot identity or checksum changed.');
    }
  } catch (error) {
    const receipt = await writeRecoveryReceipt({
      recoveryDirectory,
      transactionId: journal.transactionId,
      snapshotPath,
      failures: [
        {
          mutation: witnessMutation(journal),
          error: error instanceof Error ? error.message : String(error),
        },
      ],
    });
    throw transactionConflict(
      `Interrupted transaction metadata is invalid. Review ${receipt}.`,
    );
  }
  const commitState = await classifyCommitState(journal);
  if (journal.state === 'rolling_back' && commitState !== 'uncommitted') {
    const receipt = await writeRecoveryReceipt({
      recoveryDirectory,
      transactionId: journal.transactionId,
      snapshotPath,
      failures: [
        {
          mutation: witnessMutation(journal),
          error: 'A rollback-phase transaction no longer has its pre-commit witness.',
        },
      ],
    });
    throw transactionConflict(
      `Interrupted rollback commit state is ambiguous. Review ${receipt}.`,
    );
  }
  if (commitState === 'ambiguous') {
    const receipt = await writeRecoveryReceipt({
      recoveryDirectory,
      transactionId: journal.transactionId,
      snapshotPath,
      failures: [
        {
          mutation: witnessMutation(journal),
          error: 'Registry differs from both transaction preimage and commit witness.',
        },
      ],
    });
    throw transactionConflict(
      `Interrupted transaction commit state is ambiguous. Review ${receipt}.`,
    );
  }
  if (commitState === 'committed') {
    await finishCommitted(
      snapshotPath,
      snapshot,
      journal,
      recoveryDirectory,
      recoverExternal,
    );
    return;
  }
  const { mutations, failures } = await classifyRecovery(
    snapshot,
    journal,
  );
  if (failures.length > 0) {
    const receipt = await writeRecoveryReceipt({
      recoveryDirectory,
      transactionId: journal.transactionId,
      snapshotPath,
      failures,
    });
    throw transactionConflict(
      `Interrupted transaction needs manual recovery from ${receipt}.`,
    );
  }
  if (journal.state === 'pending') {
    journal = await markTransactionJournal(
      snapshotPath,
      journal,
      'rolling_back',
    );
  }
  await hooks?.afterRollbackPhasePersisted?.();
  const rollbackFailures = await restoreTransactionSnapshot(
    snapshotPath,
    snapshot,
    mutations,
    (mutation) =>
      validateRollbackMutationState(journal, snapshot, mutation),
    (mutation) =>
      transactionRollbackWriteArtifacts(
        journal,
        mutation.root,
        mutation.relativePath,
      ),
    (mutation) => ({
      afterTemporarySync: () =>
        hooks?.afterRollbackTemporarySync?.(mutation),
      afterDisplace: () => hooks?.afterRollbackDisplace?.(mutation),
      beforeReplace: () =>
        validateRollbackMutationState(journal, snapshot, mutation),
    }),
  );
  if (rollbackFailures.length === 0) {
    await hooks?.afterFilesystemRestored?.();
    try {
      await cleanTransactionArtifactsAfterRollback(
        journal,
        snapshot,
        hooks?.afterRollbackArtifactRemoval,
      );
    } catch (error) {
      rollbackFailures.push({
        mutation: witnessMutation(journal),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const externalFailures: ExternalRecoveryFailure[] = [];
  if (rollbackFailures.length === 0 && journal.externalRecovery) {
    if (!recoverExternal) {
      externalFailures.push({
        phase: 'compensate',
        error: 'No provider recovery handler is available.',
      });
    } else {
      try {
        await recoverExternal(journal.externalRecovery, 'rollback');
      } catch (error) {
        externalFailures.push(externalRecoveryFailure(error));
      }
    }
  }
  if (rollbackFailures.length > 0 || externalFailures.length > 0) {
    const receipt = await writeRecoveryReceipt({
      recoveryDirectory,
      transactionId: journal.transactionId,
      snapshotPath,
      failures: rollbackFailures,
      externalFailures,
    });
    throw transactionConflict(
      `Interrupted transaction recovery is incomplete. Review ${receipt}.`,
    );
  }
  await markTransactionJournal(snapshotPath, journal, 'rolled_back');
}

async function finishCommitted(
  snapshotPath: string,
  snapshot: TransactionSnapshot,
  journal: TransactionJournal,
  recoveryDirectory: string,
  recoverExternal: InterruptedExternalRecoveryHandler | undefined,
): Promise<void> {
  const { failures } = await classifyCommitted(snapshot, journal);
  const externalFailures: ExternalRecoveryFailure[] = [];
  if (failures.length === 0 && journal.externalRecovery) {
    if (!recoverExternal) {
      externalFailures.push({
        phase: 'compensate',
        error: 'No provider recovery handler is available.',
      });
    } else {
      try {
        await recoverExternal(journal.externalRecovery, 'commit');
      } catch (error) {
        externalFailures.push(externalRecoveryFailure(error));
      }
    }
  }
  if (failures.length > 0 || externalFailures.length > 0) {
    const receipt = await writeRecoveryReceipt({
      recoveryDirectory,
      transactionId: journal.transactionId,
      snapshotPath,
      failures,
      externalFailures,
    });
    throw transactionConflict(
      `Committed transaction verification is incomplete. Review ${receipt}.`,
    );
  }
  await cleanTransactionArtifactsAfterCommit(journal, snapshot);
  await markTransactionJournal(snapshotPath, journal, 'committed');
}

function externalRecoveryFailure(error: unknown): ExternalRecoveryFailure {
  return {
    phase: 'compensate',
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof AkError
      ? {
          code: error.code,
          ...(error.remediation === undefined
            ? {}
            : { remediation: error.remediation }),
        }
      : {}),
  };
}

export async function cleanTransactionArtifactsAfterCommit(
  journal: TransactionJournal,
  snapshot: TransactionSnapshot,
): Promise<void> {
  const before = await classifyCommitted(snapshot, journal);
  if (before.failures.length > 0) {
    throw transactionConflict(before.failures[0]?.error ?? 'Commit verification failed.');
  }
  await removeRecoveryArtifacts(before.artifacts);
  const after = await classifyCommitted(snapshot, journal);
  if (after.failures.length > 0 || after.artifacts.length > 0) {
    throw transactionConflict(
      after.failures[0]?.error ?? 'Committed transaction artifacts remain.',
    );
  }
}

async function classifyRecovery(
  snapshot: TransactionSnapshot,
  journal: TransactionJournal,
): Promise<{
  mutations: TransactionMutation[];
  failures: Array<{ mutation: TransactionMutation; error: string }>;
  artifacts: Array<{ root: string; relativePath: string }>;
}> {
  const outcomes = new Map(
    journal.outcomes.map((outcome) => [targetKey(outcome), outcome]),
  );
  const mutations: TransactionMutation[] = [];
  const failures: Array<{ mutation: TransactionMutation; error: string }> = [];
  const artifacts: Array<{ root: string; relativePath: string }> = [];
  if (outcomes.size !== snapshot.entries.length) {
    failures.push({
      mutation: witnessMutation(journal),
      error: 'Snapshot and journal target sets do not agree.',
    });
  }
  for (const entry of snapshot.entries) {
    const outcome = outcomes.get(targetKey(entry));
    const mutation: TransactionMutation = {
      kind: outcome?.kind ?? 'write',
      root: entry.root,
      relativePath: entry.relativePath,
    };
    if (!outcome) {
      failures.push({ mutation, error: 'Recovery outcome is missing.' });
      continue;
    }
    const current = await currentFileState(entry);
    const artifactState = await inspectRecoveryArtifacts(entry, outcome);
    artifacts.push(...artifactState.artifacts);
    if (artifactState.failure) {
      failures.push({ mutation, error: artifactState.failure });
      continue;
    }
    if (matchesPreimage(current, entry)) continue;
    if (matchesOutcome(current, outcome)) {
      mutations.push(mutation);
      continue;
    }
    if (
      !current.exists &&
      entry.existed &&
      artifactState.displacedMatchesPreimage
    ) {
      mutations.push(mutation);
      continue;
    }
    if (
      !current.exists &&
      entry.existed &&
      (artifactState.rollbackTemporaryMatchesPreimage ||
        artifactState.rollbackDisplacedMatchesKnownState)
    ) {
      mutations.push(mutation);
      continue;
    }
    failures.push({
      mutation,
      error: 'Managed file differs from both the snapshot and interrupted transaction.',
    });
  }
  return { mutations, failures, artifacts };
}

async function classifyCommitted(
  snapshot: TransactionSnapshot,
  journal: TransactionJournal,
): Promise<{
  failures: Array<{ mutation: TransactionMutation; error: string }>;
  artifacts: Array<{ root: string; relativePath: string }>;
}> {
  const outcomes = new Map(
    journal.outcomes.map((outcome) => [targetKey(outcome), outcome]),
  );
  const failures: Array<{ mutation: TransactionMutation; error: string }> = [];
  const artifacts: Array<{ root: string; relativePath: string }> = [];
  if (outcomes.size !== snapshot.entries.length) {
    failures.push({
      mutation: witnessMutation(journal),
      error: 'Committed snapshot and journal target sets do not agree.',
    });
  }
  for (const entry of snapshot.entries) {
    const outcome = outcomes.get(targetKey(entry));
    const mutation: TransactionMutation = {
      kind: outcome?.kind ?? 'write',
      root: entry.root,
      relativePath: entry.relativePath,
    };
    if (!outcome) {
      failures.push({ mutation, error: 'Committed outcome is missing.' });
      continue;
    }
    const artifactState = await inspectRecoveryArtifacts(entry, outcome);
    artifacts.push(...artifactState.artifacts);
    if (artifactState.failure) {
      failures.push({ mutation, error: artifactState.failure });
      continue;
    }
    if (!matchesOutcome(await currentFileState(entry), outcome)) {
      failures.push({
        mutation,
        error: 'Committed file does not match its intended postimage.',
      });
    }
  }
  return { failures, artifacts };
}

async function inspectRecoveryArtifacts(
  entry: SnapshotEntry,
  outcome: RecoveryOutcome,
): Promise<{
  artifacts: Array<{ root: string; relativePath: string }>;
  displacedMatchesPreimage: boolean;
  rollbackTemporaryMatchesPreimage: boolean;
  rollbackDisplacedMatchesKnownState: boolean;
  failure?: string;
}> {
  const artifacts: Array<{ root: string; relativePath: string }> = [];
  let displacedMatchesPreimage = false;
  let rollbackTemporaryMatchesPreimage = false;
  let rollbackDisplacedMatchesKnownState = false;
  if (outcome.temporaryRelativePath) {
    const temporary = await optionalArtifactState(
      outcome.root,
      outcome.temporaryRelativePath,
    );
    if (temporary) {
      artifacts.push({
        root: outcome.root,
        relativePath: outcome.temporaryRelativePath,
      });
      if (temporary.sha256 !== outcome.afterSha256) {
        return {
          artifacts,
          displacedMatchesPreimage,
          rollbackTemporaryMatchesPreimage,
          rollbackDisplacedMatchesKnownState,
          failure: 'Transaction temporary file has unexpected bytes.',
        };
      }
    }
  }
  if (outcome.displacedRelativePath) {
    const displaced = await optionalArtifactState(
      outcome.root,
      outcome.displacedRelativePath,
    );
    if (displaced) {
      artifacts.push({
        root: outcome.root,
        relativePath: outcome.displacedRelativePath,
      });
      displacedMatchesPreimage =
        entry.existed && displaced.sha256 === entry.sha256;
      if (!displacedMatchesPreimage) {
        return {
          artifacts,
          displacedMatchesPreimage,
          rollbackTemporaryMatchesPreimage,
          rollbackDisplacedMatchesKnownState,
          failure: 'Transaction displaced file has unexpected bytes.',
        };
      }
    }
  }
  const rollbackTemporary = await optionalArtifactState(
    outcome.root,
    outcome.rollbackTemporaryRelativePath,
  );
  if (rollbackTemporary) {
    artifacts.push({
      root: outcome.root,
      relativePath: outcome.rollbackTemporaryRelativePath,
    });
    rollbackTemporaryMatchesPreimage =
      entry.existed && rollbackTemporary.sha256 === entry.sha256;
    if (!rollbackTemporaryMatchesPreimage) {
      return {
        artifacts,
        displacedMatchesPreimage,
        rollbackTemporaryMatchesPreimage,
        rollbackDisplacedMatchesKnownState,
        failure: 'Rollback temporary file has unexpected bytes.',
      };
    }
  }
  const rollbackDisplaced = await optionalArtifactState(
    outcome.root,
    outcome.rollbackDisplacedRelativePath,
  );
  if (rollbackDisplaced) {
    artifacts.push({
      root: outcome.root,
      relativePath: outcome.rollbackDisplacedRelativePath,
    });
    rollbackDisplacedMatchesKnownState =
      (entry.existed && rollbackDisplaced.sha256 === entry.sha256) ||
      (!outcome.absent && rollbackDisplaced.sha256 === outcome.afterSha256);
    if (!rollbackDisplacedMatchesKnownState) {
      return {
        artifacts,
        displacedMatchesPreimage,
        rollbackTemporaryMatchesPreimage,
        rollbackDisplacedMatchesKnownState,
        failure: 'Rollback displaced file has unexpected bytes.',
      };
    }
  }
  return {
    artifacts,
    displacedMatchesPreimage,
    rollbackTemporaryMatchesPreimage,
    rollbackDisplacedMatchesKnownState,
  };
}

async function optionalArtifactState(
  root: string,
  relativePath: string,
): Promise<{ sha256: string } | undefined> {
  const target = await resolveWithinRoot(root, relativePath);
  const info = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!info) return undefined;
  if (!info.isFile() || info.isSymbolicLink()) {
    throw transactionConflict(
      `Transaction artifact is not a regular file: ${relativePath}`,
    );
  }
  return { sha256: await sha256File(target) };
}

async function removeRecoveryArtifacts(
  artifacts: Array<{ root: string; relativePath: string }>,
  afterRemoval?: (
    artifact: { root: string; relativePath: string },
  ) => void | Promise<void>,
): Promise<void> {
  for (const artifact of artifacts) {
    const target = await resolveWithinRoot(artifact.root, artifact.relativePath);
    await removeFileDurably(target, { force: true });
    await afterRemoval?.(artifact);
  }
}

async function currentFileState(
  entry: SnapshotEntry,
): Promise<
  | { exists: false }
  | { exists: true; sha256: string; size: number; mode: number }
> {
  const target = await resolveWithinRoot(entry.root, entry.relativePath);
  const info = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!info) return { exists: false };
  if (!info.isFile() || info.isSymbolicLink()) {
    throw transactionConflict(
      `Interrupted transaction target is no longer a regular file: ${entry.relativePath}`,
    );
  }
  return {
    exists: true,
    sha256: await sha256File(target),
    size: info.size,
    mode: info.mode & 0o777,
  };
}

function matchesPreimage(
  current: Awaited<ReturnType<typeof currentFileState>>,
  entry: SnapshotEntry,
): boolean {
  return entry.existed
    ? current.exists &&
        current.sha256 === entry.sha256 &&
        current.size === entry.size &&
        modeMatches(current.mode, entry.mode)
    : !current.exists;
}

function matchesOutcome(
  current: Awaited<ReturnType<typeof currentFileState>>,
  outcome: RecoveryOutcome,
): boolean {
  return outcome.absent
    ? !current.exists
    : current.exists &&
        current.sha256 === outcome.afterSha256 &&
        current.size === outcome.afterSize &&
        modeMatches(current.mode, outcome.afterMode);
}

function modeMatches(actual: number, expected: number | undefined): boolean {
  return process.platform === 'win32' || expected === undefined || actual === expected;
}

function recoveryOutcomes(
  prepared: PreparedTransaction,
  transactionId: string,
): RecoveryOutcome[] {
  const raw = [
    ...prepared.deletes.map(({ mutation }) => ({ ...mutation, absent: true as const })),
    ...(prepared.manifestDelete
      ? [{ ...prepared.manifestDelete.mutation, absent: true as const }]
      : []),
    ...prepared.writes.map(({ write, kind }) => ({
      kind,
      root: write.root,
      relativePath: write.relativePath,
      afterSha256: sha256Bytes(write.contents),
      afterMode: write.mode ?? 0o600,
      afterSize:
        typeof write.contents === 'string'
          ? Buffer.byteLength(write.contents)
          : write.contents.byteLength,
    })),
  ];
  return raw.map((outcome, index) => {
    const rollbackArtifacts = transactionArtifactPaths(
      transactionId,
      index,
      outcome.relativePath,
      'rollback',
    );
    if ('absent' in outcome) return { ...outcome, ...rollbackArtifacts };
    const artifacts = transactionArtifactPaths(
      transactionId,
      index,
      outcome.relativePath,
      'forward',
    );
    return { ...outcome, ...artifacts, ...rollbackArtifacts };
  });
}

function commitWitness(
  outcomes: RecoveryOutcome[],
  snapshot: TransactionSnapshot,
): { commitWitness?: CommitWitness } {
  const registry = outcomes.find((outcome) => outcome.kind === 'registry');
  if (!registry?.afterSha256) return {};
  const entry = snapshot.entries.find(
    (candidate) => targetKey(candidate) === targetKey(registry),
  );
  if (!entry) {
    throw transactionConflict('Registry commit witness has no snapshot preimage.');
  }
  return {
    commitWitness: {
      root: registry.root,
      relativePath: registry.relativePath,
      ...(entry.existed
        ? { beforeSha256: entry.sha256 as string }
        : { beforeAbsent: true as const }),
      afterSha256: registry.afterSha256,
    },
  };
}

async function classifyCommitState(
  journal: TransactionJournal,
): Promise<'uncommitted' | 'committed' | 'ambiguous'> {
  const witness = journal.commitWitness;
  if (!witness) return 'uncommitted';
  const current = await currentFileState({
    root: witness.root,
    relativePath: witness.relativePath,
    existed: witness.beforeAbsent !== true,
    ...(witness.beforeSha256 ? { sha256: witness.beforeSha256 } : {}),
  });
  const beforeMatches = witness.beforeAbsent
    ? !current.exists
    : current.exists && current.sha256 === witness.beforeSha256;
  if (current.exists && current.sha256 === witness.afterSha256) {
    return 'committed';
  }
  return beforeMatches ? 'uncommitted' : 'ambiguous';
}

function witnessMutation(journal: TransactionJournal): TransactionMutation {
  if (journal.commitWitness) {
    return {
      kind: 'registry',
      root: journal.commitWitness.root,
      relativePath: journal.commitWitness.relativePath,
    };
  }
  const witness = journal.outcomes[0];
  return {
    kind: witness?.kind ?? 'registry',
    root: witness?.root ?? journal.roots[0] ?? journal.snapshotPath,
    relativePath: witness?.relativePath ?? 'installed-kits.json',
  };
}

export function transactionWriteArtifacts(
  journal: TransactionJournal,
  root: string,
  relativePath: string,
): { temporaryRelativePath: string; displacedRelativePath: string } | undefined {
  const outcome = journal.outcomes.find(
    (candidate) =>
      targetKey(candidate) === targetKey({ root, relativePath }),
  );
  if (!outcome?.temporaryRelativePath || !outcome.displacedRelativePath) {
    return undefined;
  }
  return {
    temporaryRelativePath: outcome.temporaryRelativePath,
    displacedRelativePath: outcome.displacedRelativePath,
  };
}

export function transactionRollbackWriteArtifacts(
  journal: TransactionJournal,
  root: string,
  relativePath: string,
): { temporaryRelativePath: string; displacedRelativePath: string } | undefined {
  const outcome = journal.outcomes.find(
    (candidate) =>
      targetKey(candidate) === targetKey({ root, relativePath }),
  );
  if (!outcome) return undefined;
  return {
    temporaryRelativePath: outcome.rollbackTemporaryRelativePath,
    displacedRelativePath: outcome.rollbackDisplacedRelativePath,
  };
}

export async function validateRollbackWriteArtifacts(
  journal: TransactionJournal,
  snapshot: TransactionSnapshot,
  mutations: TransactionMutation[],
): Promise<void> {
  for (const mutation of mutations) {
    await validateRollbackMutationState(journal, snapshot, mutation);
  }
}

export async function validateRollbackMutationState(
  journal: TransactionJournal,
  snapshot: TransactionSnapshot,
  mutation: TransactionMutation,
): Promise<void> {
  const entry = snapshot.entries.find(
    (candidate) => targetKey(candidate) === targetKey(mutation),
  );
  const outcome = journal.outcomes.find(
    (candidate) => targetKey(candidate) === targetKey(mutation),
  );
  if (!entry) throw transactionConflict('Rollback snapshot entry is missing.');
  if (!outcome) throw transactionConflict('Rollback outcome is missing.');

  const current = await currentFileState(entry);
  const artifacts = await inspectRecoveryArtifacts(entry, outcome);
  if (artifacts.failure) throw transactionConflict(artifacts.failure);
  const recognized =
    matchesPreimage(current, entry) ||
    matchesOutcome(current, outcome) ||
    (!current.exists &&
      entry.existed &&
      (artifacts.displacedMatchesPreimage ||
        artifacts.rollbackTemporaryMatchesPreimage ||
        artifacts.rollbackDisplacedMatchesKnownState));
  if (!recognized) {
    throw transactionConflict(
      `Managed file changed before rollback: ${entry.relativePath}`,
    );
  }
}

export async function cleanTransactionArtifactsAfterRollback(
  journal: TransactionJournal,
  snapshot: TransactionSnapshot,
  afterArtifactRemoval?: (
    artifact: { root: string; relativePath: string },
  ) => void | Promise<void>,
): Promise<void> {
  await assertSnapshotPreimages(snapshot);
  const outcomes = new Map(
    journal.outcomes.map((outcome) => [targetKey(outcome), outcome]),
  );
  const artifacts: Array<{ root: string; relativePath: string }> = [];
  for (const entry of snapshot.entries) {
    const outcome = outcomes.get(targetKey(entry));
    if (!outcome) throw transactionConflict('Rollback outcome is missing.');
    const inspected = await inspectRecoveryArtifacts(entry, outcome);
    if (inspected.failure) throw transactionConflict(inspected.failure);
    artifacts.push(...inspected.artifacts);
  }
  await removeRecoveryArtifacts(artifacts, afterArtifactRemoval);
  await assertSnapshotPreimages(snapshot);
}

async function assertSnapshotPreimages(
  snapshot: TransactionSnapshot,
): Promise<void> {
  for (const entry of snapshot.entries) {
    if (!matchesPreimage(await currentFileState(entry), entry)) {
      throw transactionConflict(
        `Rollback did not restore the exact preimage: ${entry.relativePath}`,
      );
    }
  }
}

function transactionArtifactPaths(
  transactionId: string,
  index: number,
  relativePath: string,
  phase: 'forward',
): { temporaryRelativePath: string; displacedRelativePath: string };
function transactionArtifactPaths(
  transactionId: string,
  index: number,
  relativePath: string,
  phase: 'rollback',
): {
  rollbackTemporaryRelativePath: string;
  rollbackDisplacedRelativePath: string;
};
function transactionArtifactPaths(
  transactionId: string,
  index: number,
  relativePath: string,
  phase: 'forward' | 'rollback',
):
  | { temporaryRelativePath: string; displacedRelativePath: string }
  | {
      rollbackTemporaryRelativePath: string;
      rollbackDisplacedRelativePath: string;
    } {
  const directory = path.posix.dirname(relativePath);
  const prefix = directory === '.' ? '' : `${directory}/`;
  const basename = path.posix.basename(relativePath);
  const suffix = `${transactionId}-${index.toString(16).padStart(8, '0')}`;
  return phase === 'forward'
    ? {
        temporaryRelativePath: `${prefix}.${basename}.ak-${suffix}.tmp`,
        displacedRelativePath: `${prefix}.${basename}.ak-swap-${suffix}`,
      }
    : {
        rollbackTemporaryRelativePath: `${prefix}.${basename}.ak-rollback-${suffix}.tmp`,
        rollbackDisplacedRelativePath: `${prefix}.${basename}.ak-rollback-swap-${suffix}`,
      };
}

function withChecksum(
  value: Omit<TransactionJournal, 'checksumSha256'>,
): TransactionJournal {
  return {
    ...value,
    checksumSha256: sha256Bytes(JSON.stringify(value)),
  };
}

async function writeJournal(
  snapshotPath: string,
  journal: TransactionJournal,
): Promise<void> {
  const root = await canonicalizeRoot(snapshotPath);
  const target = await resolveWithinRoot(root, JOURNAL_FILE);
  const temporary = await resolveWithinRoot(root, '.journal.pending.tmp');
  await writeNewAtomicFile(
    root,
    target,
    temporary,
    `${JSON.stringify(journal, null, 2)}\n`,
  );
}

async function loadJournal(
  snapshotPath: string,
): Promise<TransactionJournal | undefined> {
  const root = await canonicalizeRoot(snapshotPath);
  const target = await resolveWithinRoot(root, JOURNAL_FILE);
  const info = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!info) return undefined;
  if (!info.isFile() || info.isSymbolicLink()) {
    throw transactionConflict('Transaction journal is not a regular file.');
  }
  if (info.size > MAX_JOURNAL_BYTES) {
    throw transactionConflict('Transaction journal is too large.');
  }
  const journal = parseJournal(JSON.parse(await fs.readFile(target, 'utf8')));
  if (normalizePath(journal.snapshotPath) !== normalizePath(root)) {
    throw transactionConflict('Transaction journal points at another snapshot.');
  }
  return {
    ...journal,
    state: await readJournalMarkerState(root, journal),
  };
}

async function writeJournalMarker(
  snapshotPath: string,
  journal: TransactionJournal,
  state: 'rolling_back' | 'committed' | 'rolled_back',
): Promise<void> {
  const root = await canonicalizeRoot(snapshotPath);
  const current = await readJournalMarkerState(root, journal);
  if (current === state || (current === 'rolled_back' && state === 'rolled_back')) {
    return;
  }
  if (
    current === 'committed' ||
    current === 'rolled_back' ||
    (current === 'rolling_back' && state === 'committed')
  ) {
    throw transactionConflict(
      `Transaction journal cannot move from ${current} to ${state}.`,
    );
  }
  const payload = {
    version: 1,
    state,
    transactionId: journal.transactionId,
    journalChecksumSha256: journal.checksumSha256,
    createdAt: new Date().toISOString(),
  };
  const target = await resolveWithinRoot(root, JOURNAL_MARKERS[state]);
  const temporary = await resolveWithinRoot(
    root,
    `.${JOURNAL_MARKERS[state]}.tmp`,
  );
  await writeNewAtomicFile(
    root,
    target,
    temporary,
    `${JSON.stringify(payload, null, 2)}\n`,
  );
}

async function readJournalMarkerState(
  root: string,
  journal: TransactionJournal,
): Promise<TransactionJournal['state']> {
  const found: Array<'rolling_back' | 'committed' | 'rolled_back'> = [];
  for (const state of [
    'rolling_back',
    'committed',
    'rolled_back',
  ] as const) {
    const target = await resolveWithinRoot(root, JOURNAL_MARKERS[state]);
    const info = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!info) continue;
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) {
      throw transactionConflict('Transaction journal marker is invalid.');
    }
    const value = JSON.parse(await fs.readFile(target, 'utf8')) as unknown;
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      value.state !== state ||
      value.transactionId !== journal.transactionId ||
      value.journalChecksumSha256 !== journal.checksumSha256 ||
      typeof value.createdAt !== 'string'
    ) {
      throw transactionConflict('Transaction journal marker is invalid.');
    }
    found.push(state);
  }
  if (found.includes('committed') && found.length > 1) {
    throw transactionConflict('Transaction journal has conflicting markers.');
  }
  if (found.includes('rolled_back')) return 'rolled_back';
  if (found.includes('committed')) return 'committed';
  if (found.includes('rolling_back')) return 'rolling_back';
  return 'pending';
}

async function writeExclusiveDurableFile(
  target: string,
  contents: string,
): Promise<void> {
  let handle;
  try {
    handle = await fs.open(target, 'wx', 0o600);
    await handle.writeFile(contents);
    await handle.sync();
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (handle) {
      await fs.rm(target, { force: true }).catch(() => undefined);
    }
    throw error;
  }
  await handle.close();
}

async function writeNewAtomicFile(
  root: string,
  target: string,
  temporary: string,
  contents: string,
): Promise<void> {
  const temporaryInfo = await fs
    .lstat(temporary)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
  if (temporaryInfo) {
    if (!temporaryInfo.isFile() || temporaryInfo.isSymbolicLink()) {
      throw transactionConflict('Transaction journal temporary file is invalid.');
    }
    await fs.rm(temporary);
  }
  await writeExclusiveDurableFile(temporary, contents);
  const existing = await fs
    .readFile(target, 'utf8')
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
  if (existing !== undefined) {
    if (existing !== contents) {
      await fs.rm(temporary, { force: true });
      throw transactionConflict('Transaction journal target already exists.');
    }
    await fs.rm(temporary, { force: true });
    return;
  }
  try {
    await fs.rename(temporary, target);
  } catch (error) {
    const targetContents = await fs.readFile(target, 'utf8').catch(() => undefined);
    if (targetContents !== contents) throw error;
    await fs.rm(temporary, { force: true });
  }
  await syncDirectory(root);
}

async function syncDirectory(directoryPath: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await fs.open(directoryPath, 'r');
  await handle.sync().finally(() => handle.close());
}

function parseJournal(value: unknown): TransactionJournal {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.state !== 'pending' ||
    typeof value.transactionId !== 'string' ||
    typeof value.snapshotPath !== 'string' ||
    !path.isAbsolute(value.snapshotPath) ||
    !isSha256(value.snapshotSha256) ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string' ||
    !Array.isArray(value.roots) ||
    !Array.isArray(value.outcomes) ||
    value.outcomes.length > 100_000 ||
    !isSha256(value.checksumSha256)
  ) {
    throw transactionConflict('Transaction journal is invalid.');
  }
  const { checksumSha256, ...unsigned } = value;
  if (sha256Bytes(JSON.stringify(unsigned)) !== checksumSha256) {
    throw transactionConflict('Transaction journal checksum is invalid.');
  }
  const roots = value.roots.map((root) => {
    if (typeof root !== 'string' || !path.isAbsolute(root)) {
      throw transactionConflict('Transaction journal root is invalid.');
    }
    return path.resolve(root);
  });
  const rootKeys = new Set(roots.map(normalizePath));
  const seen = new Set<string>();
  const outcomes = value.outcomes.map((raw): RecoveryOutcome => {
    if (
      !isRecord(raw) ||
      !isMutationKind(raw.kind) ||
      typeof raw.root !== 'string' ||
      !rootKeys.has(normalizePath(raw.root)) ||
      typeof raw.relativePath !== 'string'
    ) {
      throw transactionConflict('Transaction journal outcome is invalid.');
    }
    assertPortableRelativePath(raw.relativePath);
    const key = targetKey({
      root: path.resolve(raw.root),
      relativePath: raw.relativePath,
    });
    if (seen.has(key)) {
      throw transactionConflict('Transaction journal has duplicate targets.');
    }
    seen.add(key);
    if (
      typeof raw.rollbackTemporaryRelativePath !== 'string' ||
      typeof raw.rollbackDisplacedRelativePath !== 'string'
    ) {
      throw transactionConflict('Transaction rollback artifact paths are missing.');
    }
    assertPortableRelativePath(raw.rollbackTemporaryRelativePath);
    assertPortableRelativePath(raw.rollbackDisplacedRelativePath);
    const targetDirectory = path.posix.dirname(raw.relativePath);
    if (
      path.posix.dirname(raw.rollbackTemporaryRelativePath) !==
        targetDirectory ||
      path.posix.dirname(raw.rollbackDisplacedRelativePath) !==
        targetDirectory ||
      raw.rollbackTemporaryRelativePath === raw.relativePath ||
      raw.rollbackDisplacedRelativePath === raw.relativePath ||
      raw.rollbackTemporaryRelativePath === raw.rollbackDisplacedRelativePath
    ) {
      throw transactionConflict('Transaction rollback artifact paths are invalid.');
    }
    if (raw.absent === true && raw.afterSha256 === undefined) {
      return {
        kind: raw.kind,
        root: path.resolve(raw.root),
        relativePath: raw.relativePath,
        absent: true,
        rollbackTemporaryRelativePath: raw.rollbackTemporaryRelativePath,
        rollbackDisplacedRelativePath: raw.rollbackDisplacedRelativePath,
      };
    }
    if (
      raw.absent === undefined &&
      isSha256(raw.afterSha256) &&
      typeof raw.afterMode === 'number' &&
      Number.isSafeInteger(raw.afterMode) &&
      raw.afterMode >= 0 &&
      raw.afterMode <= 0o777 &&
      typeof raw.afterSize === 'number' &&
      Number.isSafeInteger(raw.afterSize) &&
      raw.afterSize >= 0 &&
      typeof raw.temporaryRelativePath === 'string' &&
      typeof raw.displacedRelativePath === 'string'
    ) {
      assertPortableRelativePath(raw.temporaryRelativePath);
      assertPortableRelativePath(raw.displacedRelativePath);
      if (
        path.posix.dirname(raw.temporaryRelativePath) !== targetDirectory ||
        path.posix.dirname(raw.displacedRelativePath) !== targetDirectory ||
        raw.temporaryRelativePath === raw.relativePath ||
        raw.displacedRelativePath === raw.relativePath
      ) {
        throw transactionConflict('Transaction artifact paths are invalid.');
      }
      return {
        kind: raw.kind,
        root: path.resolve(raw.root),
        relativePath: raw.relativePath,
        afterSha256: raw.afterSha256,
        afterMode: raw.afterMode,
        afterSize: raw.afterSize,
        temporaryRelativePath: raw.temporaryRelativePath,
        displacedRelativePath: raw.displacedRelativePath,
        rollbackTemporaryRelativePath: raw.rollbackTemporaryRelativePath,
        rollbackDisplacedRelativePath: raw.rollbackDisplacedRelativePath,
      };
    }
    throw transactionConflict('Transaction journal outcome state is invalid.');
  });
  const managedTargets = new Set(outcomes.map(targetKey));
  const artifactTargets = new Set<string>();
  for (const outcome of outcomes) {
    for (const relativePath of [
      outcome.temporaryRelativePath,
      outcome.displacedRelativePath,
      outcome.rollbackTemporaryRelativePath,
      outcome.rollbackDisplacedRelativePath,
    ]) {
      if (!relativePath) continue;
      const key = targetKey({ root: outcome.root, relativePath });
      if (managedTargets.has(key) || artifactTargets.has(key)) {
        throw transactionConflict(
          'Transaction artifact paths overlap managed targets.',
        );
      }
      artifactTargets.add(key);
    }
  }
  const parsedWitness = parseCommitWitness(value.commitWitness, rootKeys);
  if (parsedWitness) {
    const registryOutcome = outcomes.find(
      (outcome) =>
        outcome.kind === 'registry' &&
        targetKey(outcome) === targetKey(parsedWitness),
    );
    if (
      !registryOutcome ||
      registryOutcome.afterSha256 !== parsedWitness.afterSha256
    ) {
      throw transactionConflict(
        'Transaction commit witness does not match the registry outcome.',
      );
    }
  }
  const externalRecovery = parseExternalRecovery(value.externalRecovery, rootKeys);
  return {
    version: 1,
    state: value.state,
    transactionId: value.transactionId,
    snapshotPath: path.resolve(value.snapshotPath),
    snapshotSha256: value.snapshotSha256,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    roots,
    outcomes,
    ...(parsedWitness ? { commitWitness: parsedWitness } : {}),
    ...(externalRecovery ? { externalRecovery } : {}),
    checksumSha256,
  };
}

function parseCommitWitness(
  value: unknown,
  rootKeys: Set<string>,
): CommitWitness | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    typeof value.root !== 'string' ||
    !rootKeys.has(normalizePath(value.root)) ||
    typeof value.relativePath !== 'string' ||
    !isSha256(value.afterSha256) ||
    !(
      (value.beforeAbsent === true && value.beforeSha256 === undefined) ||
      (value.beforeAbsent === undefined && isSha256(value.beforeSha256))
    )
  ) {
    throw transactionConflict('Transaction commit witness is invalid.');
  }
  assertPortableRelativePath(value.relativePath);
  return {
    root: path.resolve(value.root),
    relativePath: value.relativePath,
    ...(value.beforeAbsent === true
      ? { beforeAbsent: true as const }
      : { beforeSha256: value.beforeSha256 as string }),
    afterSha256: value.afterSha256,
  };
}

function parseExternalRecovery(
  value: unknown,
  rootKeys: Set<string>,
): TransactionExternalRecovery | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    value.kind !== 'claude-code-project-plugin' ||
    !['install', 'update', 'uninstall'].includes(String(value.operation)) ||
    !['add', 'remove', 'retain'].includes(String(value.marketplaceMutation)) ||
    typeof value.projectRoot !== 'string' ||
    !rootKeys.has(normalizePath(value.projectRoot)) ||
    typeof value.pluginReference !== 'string' ||
    !/^ak-[a-z0-9-]+@agentkit-local$/u.test(value.pluginReference) ||
    !(
      (value.marketplaceBeforeAbsent === true &&
        value.marketplaceBeforeSha256 === undefined) ||
      (value.marketplaceBeforeAbsent === undefined &&
        isSha256(value.marketplaceBeforeSha256))
    ) ||
    !isSha256(value.marketplaceAfterSha256) ||
    !isRecord(value.before) ||
    !isRecord(value.after)
  ) {
    throw transactionConflict('Transaction provider recovery is invalid.');
  }
  const before = parseProviderState(value.before, 'preimage');
  const after = parseProviderState(value.after, 'postimage');
  const operation = value.operation as 'install' | 'update' | 'uninstall';
  const marketplaceMutation = value.marketplaceMutation as
    | 'add'
    | 'remove'
    | 'retain';
  if (
    (operation === 'install' &&
      (before.pluginInstalled || !after.pluginInstalled)) ||
    (operation === 'update' &&
      (!before.pluginInstalled || !after.pluginInstalled)) ||
    (operation === 'uninstall' &&
      (!before.pluginInstalled || after.pluginInstalled)) ||
    (marketplaceMutation === 'add' &&
      (before.marketplaceKnown || !after.marketplaceKnown)) ||
    (marketplaceMutation === 'remove' &&
      (!before.marketplaceKnown || after.marketplaceKnown)) ||
    (marketplaceMutation === 'retain' &&
      before.marketplaceKnown !== after.marketplaceKnown)
  ) {
    throw transactionConflict('Transaction provider recovery transition is invalid.');
  }
  return {
    kind: 'claude-code-project-plugin',
    operation,
    marketplaceMutation,
    projectRoot: path.resolve(value.projectRoot),
    pluginReference: value.pluginReference,
    ...(value.marketplaceBeforeAbsent === true
      ? { marketplaceBeforeAbsent: true as const }
      : { marketplaceBeforeSha256: value.marketplaceBeforeSha256 as string }),
    marketplaceAfterSha256: value.marketplaceAfterSha256 as string,
    before,
    after,
  };
}

function parseProviderState(
  value: Record<string, unknown>,
  label: string,
): TransactionExternalRecovery['before'] {
  if (
    typeof value.pluginInstalled !== 'boolean' ||
    typeof value.pluginEnabled !== 'boolean' ||
    (value.pluginVersion !== undefined &&
      typeof value.pluginVersion !== 'string') ||
    typeof value.marketplaceKnown !== 'boolean' ||
    typeof value.marketplaceConflict !== 'boolean' ||
    typeof value.marketplaceHasOtherPlugins !== 'boolean' ||
    !Array.isArray(value.marketplaceOtherPlugins)
  ) {
    throw transactionConflict(`Transaction provider ${label} is invalid.`);
  }
  const marketplaceOtherPlugins = value.marketplaceOtherPlugins.map(
    (candidate) => {
      if (
        !isRecord(candidate) ||
        typeof candidate.reference !== 'string' ||
        !/^ak-[a-z0-9-]+@agentkit-local$/u.test(candidate.reference) ||
        typeof candidate.enabled !== 'boolean' ||
        (candidate.version !== undefined &&
          typeof candidate.version !== 'string')
      ) {
        throw transactionConflict(
          `Transaction provider ${label} shared-plugin witness is invalid.`,
        );
      }
      return {
        reference: candidate.reference,
        enabled: candidate.enabled,
        ...(typeof candidate.version === 'string'
          ? { version: candidate.version }
          : {}),
      };
    },
  );
  const sortedWitness = [...marketplaceOtherPlugins].sort((left, right) =>
    left.reference.localeCompare(right.reference),
  );
  if (
    new Set(sortedWitness.map(({ reference }) => reference)).size !==
      sortedWitness.length ||
    JSON.stringify(marketplaceOtherPlugins) !== JSON.stringify(sortedWitness) ||
    value.marketplaceHasOtherPlugins !== (sortedWitness.length > 0)
  ) {
    throw transactionConflict(
      `Transaction provider ${label} shared-plugin witness is inconsistent.`,
    );
  }
  return {
    pluginInstalled: value.pluginInstalled,
    pluginEnabled: value.pluginEnabled,
    ...(typeof value.pluginVersion === 'string'
      ? { pluginVersion: value.pluginVersion }
      : {}),
    marketplaceKnown: value.marketplaceKnown,
    marketplaceConflict: value.marketplaceConflict,
    marketplaceHasOtherPlugins: value.marketplaceHasOtherPlugins,
    marketplaceOtherPlugins: sortedWitness,
  };
}

function targetKey(target: { root: string; relativePath: string }): string {
  return `${normalizePath(target.root)}\0${target.relativePath}`;
}

function normalizePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isMutationKind(value: unknown): value is TransactionMutation['kind'] {
  return (
    value === 'write' ||
    value === 'delete' ||
    value === 'metadata' ||
    value === 'manifest' ||
    value === 'registry'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
