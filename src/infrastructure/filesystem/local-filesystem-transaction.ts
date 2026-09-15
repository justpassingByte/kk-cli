import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { AkError } from '../../domain/contracts/ak-error.js';
import type {
  FilesystemTransactionPlan,
  FilesystemTransactionResult,
  TransactionFileWrite,
  TransactionMutation,
} from '../../domain/lifecycle/filesystem-transaction.js';
import { classifyInstalledPath } from '../installed-kits/ownership-classifier.js';
import { atomicWriteFile } from './atomic-write.js';
import { sha256File } from './file-hash.js';
import { resolveWithinRoot } from './path-guard.js';
import { displaceFileDurably } from './durable-file-removal.js';
import {
  writeRecoveryReceipt,
  type ExternalRecoveryFailure,
} from './recovery-receipt.js';
import {
  cleanTransactionArtifactsAfterCommit,
  cleanTransactionArtifactsAfterRollback,
  createPendingTransactionJournal,
  markTransactionJournal,
  recoverInterruptedTransactions,
  transactionRollbackWriteArtifacts,
  transactionWriteArtifacts,
  validateRollbackMutationState,
  type InterruptedExternalRecoveryHandler,
  type InterruptedRecoveryHooks,
  type TransactionJournal,
} from './transaction-journal.js';
import {
  captureTransactionSnapshot,
  restoreTransactionSnapshot,
  type TransactionSnapshot,
} from './transaction-snapshot.js';
import { transactionConflict, transactionFailure } from './transaction-errors.js';
import {
  prepareFilesystemTransaction,
  transactionSnapshotTargets,
  type PreparedDelete,
} from './transaction-preparation.js';
import {
  acquireTransactionRootLocks,
  canonicalizeTransactionRoots,
  releaseTransactionRootLocks,
  revalidateTransactionRoots,
} from './transaction-root-lock.js';

export class LocalFilesystemTransaction {
  constructor(
    private readonly recoverExternal?: InterruptedExternalRecoveryHandler,
    private readonly recoveryHooks?: InterruptedRecoveryHooks,
  ) {}

  async recover(
    snapshotDirectory: string,
    recoveryDirectory: string,
  ): Promise<string[]> {
    return recoverInterruptedTransactions(
      snapshotDirectory,
      recoveryDirectory,
      this.recoverExternal,
      this.recoveryHooks,
    );
  }

  async run(plan: FilesystemTransactionPlan): Promise<FilesystemTransactionResult> {
    await this.recover(plan.snapshotDirectory, plan.recoveryDirectory);
    const transactionId = randomUUID();
    const canonicalRoots = await canonicalizeTransactionRoots(plan.roots);
    const releases = await acquireTransactionRootLocks(canonicalRoots);
    let snapshotPath = '';
    let snapshot: TransactionSnapshot | undefined;
    let journal: TransactionJournal | undefined;
    const mutations: TransactionMutation[] = [];
    const externalFailures: ExternalRecoveryFailure[] = [];
    const externalStep = plan.externalStep;
    const externalStepPosition = externalStep?.position ?? 'before-metadata';
    let externalStepPending = false;
    let externalStepFailurePhase: 'apply' | 'verify' | undefined;
    let registryCommitted = false;

    try {
      await revalidateTransactionRoots(canonicalRoots);
      await plan.hooks?.revalidate?.();
      const prepared = await prepareFilesystemTransaction(plan, canonicalRoots);
      const snapshotTargets = transactionSnapshotTargets(prepared);
      const captured = await captureTransactionSnapshot(plan.snapshotDirectory, transactionId, snapshotTargets);
      snapshotPath = captured.path;
      snapshot = captured.snapshot;
      await plan.hooks?.afterSnapshot?.(snapshotPath);
      journal = await createPendingTransactionJournal(
        snapshotPath,
        transactionId,
        canonicalRoots,
        snapshot,
        prepared,
        externalStep?.recovery,
      );

      if (externalStepPosition === 'before-mutations' && externalStep !== undefined) {
        externalStepPending = true;
        await applyAndVerifyExternalStep(externalStep, (phase) => {
          externalStepFailurePhase = phase;
        });
      }
      for (const deletion of prepared.deletes) {
        await applyDeletion(deletion, plan, mutations, journal);
      }
      for (const pending of prepared.writes.filter(({ kind }) => kind === 'write')) {
        await applyWrite(pending.write, pending.kind, plan, mutations, journal);
      }
      if (externalStepPosition === 'before-metadata' && externalStep !== undefined) {
        externalStepPending = true;
        await applyAndVerifyExternalStep(externalStep, (phase) => {
          externalStepFailurePhase = phase;
        });
      }
      for (const pending of prepared.writes.filter(({ kind }) => kind === 'metadata')) {
        await applyWrite(pending.write, pending.kind, plan, mutations, journal);
      }
      if (prepared.manifestDelete !== undefined) {
        await applyDeletion(prepared.manifestDelete, plan, mutations, journal);
      }
      const manifest = prepared.writes.find(({ kind }) => kind === 'manifest');
      if (manifest !== undefined) {
        await applyWrite(manifest.write, manifest.kind, plan, mutations, journal);
      }
      const registry = prepared.writes.find(({ kind }) => kind === 'registry');
      if (registry !== undefined) {
        await applyWrite(registry.write, registry.kind, plan, mutations, journal);
        registryCommitted = true;
      }
      await cleanTransactionArtifactsAfterCommit(journal, snapshot);
      journal = await markTransactionJournal(snapshotPath, journal, 'committed');
      externalStepPending = false;

      return {
        transactionId,
        snapshotPath,
        classifications: prepared.classifications,
        mutations,
      };
    } catch (error) {
      if (registryCommitted) {
        throw new AkError(
          'Lifecycle changes committed, but the recovery journal could not be finalized.',
          {
            code: 'runtime_error',
            exitCode: 1,
            remediation:
              'Run the command again. AgentKit will verify the committed transaction before doing new work.',
            details: { transactionId, snapshotPath },
            cause: error,
          },
        );
      }
      let recoveryReceiptPath: string | undefined;
      if (externalStepPending && externalStep !== undefined) {
        externalFailures.push(
          externalFailureEvidence(error, externalStepFailurePhase, externalStep.id),
        );
        if (!externalStep.compensateAfterRollback) {
          await compensateExternalStep(externalStep, externalFailures);
        }
      }

      let failures: Array<{ mutation: TransactionMutation; error: string }> = [];
      if (snapshotPath !== '' && snapshot !== undefined) {
        try {
          if (journal) {
            if (journal.state === 'pending') {
              journal = await markTransactionJournal(
                snapshotPath,
                journal,
                'rolling_back',
              );
            }
          }
          failures = await restoreTransactionSnapshot(
            snapshotPath,
            snapshot,
            mutations,
            async (mutation) => {
              await plan.hooks?.beforeRollback?.(mutation);
              if (journal) {
                await validateRollbackMutationState(
                  journal,
                  snapshot as TransactionSnapshot,
                  mutation,
                );
              }
            },
            journal
              ? (mutation) =>
                  transactionRollbackWriteArtifacts(
                    journal as TransactionJournal,
                    mutation.root,
                    mutation.relativePath,
                  )
              : undefined,
            journal
              ? (mutation) => ({
                  beforeReplace: () =>
                    validateRollbackMutationState(
                      journal as TransactionJournal,
                      snapshot as TransactionSnapshot,
                      mutation,
                    ),
                })
              : undefined,
          );
          if (journal && failures.length === 0) {
            await cleanTransactionArtifactsAfterRollback(journal, snapshot);
          }
        } catch (rollbackPreparationError) {
          failures.push({
            mutation: mutations.at(-1) ?? {
              kind: 'write',
              root: canonicalRoots[0] as string,
              relativePath: 'unknown',
            },
            error:
              rollbackPreparationError instanceof Error
                ? rollbackPreparationError.message
                : String(rollbackPreparationError),
          });
        }
      }
      if (
        externalStepPending &&
        externalStep !== undefined &&
        externalStep.compensateAfterRollback &&
        failures.length === 0
      ) {
        await compensateExternalStep(externalStep, externalFailures);
      }
      if (
        journal &&
        failures.length === 0 &&
        !externalFailures.some(({ phase }) => phase === 'compensate')
      ) {
        try {
          journal = await markTransactionJournal(
            snapshotPath,
            journal,
            'rolled_back',
          );
        } catch (journalError) {
          externalFailures.push({
            phase: 'transaction',
            error:
              journalError instanceof Error
                ? journalError.message
                : String(journalError),
          });
        }
      }
      const compensationFailed = externalFailures.some(({ phase }) => phase === 'compensate');
      const recoveryFailed =
        failures.length > 0 ||
        compensationFailed ||
        (journal !== undefined && journal.state === 'pending');
      if (recoveryFailed) {
        recoveryReceiptPath = await writeRecoveryReceipt({
          recoveryDirectory: plan.recoveryDirectory,
          transactionId,
          snapshotPath,
          failures,
          externalFailures,
        });
      }
      throw transactionFailure(error, transactionId, snapshotPath, recoveryReceiptPath);
    } finally {
      await releaseTransactionRootLocks(releases);
    }
  }
}

async function applyAndVerifyExternalStep(
  externalStep: NonNullable<FilesystemTransactionPlan['externalStep']>,
  setPhase: (phase: 'apply' | 'verify' | undefined) => void,
): Promise<void> {
  setPhase('apply');
  await externalStep.apply();
  setPhase('verify');
  await externalStep.verify();
  setPhase(undefined);
}

async function compensateExternalStep(
  externalStep: NonNullable<FilesystemTransactionPlan['externalStep']>,
  failures: ExternalRecoveryFailure[],
): Promise<void> {
  try {
    await externalStep.compensate();
  } catch (error) {
    failures.push({
      phase: 'compensate',
      error: errorMessage(error),
      ...(externalStep.id === undefined ? {} : { stepId: externalStep.id }),
      ...(error instanceof AkError ? externalAkErrorEvidence(error) : {}),
    });
  }
}

function externalFailureEvidence(
  error: unknown,
  phase: 'apply' | 'verify' | undefined,
  stepId: string | undefined,
): ExternalRecoveryFailure {
  return {
    phase: phase ?? 'transaction',
    error: errorMessage(error),
    ...(stepId === undefined ? {} : { stepId }),
    ...(error instanceof AkError ? externalAkErrorEvidence(error) : {}),
  };
}

function externalAkErrorEvidence(error: AkError): Pick<
  ExternalRecoveryFailure,
  'code' | 'remediation'
> {
  return {
    code: error.code,
    ...(error.remediation === undefined ? {} : { remediation: error.remediation }),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function applyWrite(
  write: TransactionFileWrite,
  kind: TransactionMutation['kind'],
  plan: FilesystemTransactionPlan,
  mutations: TransactionMutation[],
  journal: TransactionJournal,
): Promise<void> {
  const mutation = { kind, root: write.root, relativePath: write.relativePath };
  const classification = await classifyInstalledPath(
    write.root,
    write.relativePath,
    write.expectedPreviousSha256,
  );
  if (classification.status === 'foreign' || classification.status === 'owned-modified') {
    throw transactionConflict(`Managed file changed during transaction: ${write.relativePath}`);
  }
  await plan.hooks?.beforeMutation?.(mutation);
  mutations.push(mutation);
  const artifacts = transactionWriteArtifacts(
    journal,
    write.root,
    write.relativePath,
  );
  await atomicWriteFile(
    write.root,
    write.relativePath,
    write.contents,
    write.mode,
    artifacts,
    {
      beforeReplace: async () => {
        if (!artifacts) return;
        const displaced = await resolveWithinRoot(
          write.root,
          artifacts.displacedRelativePath,
        );
        const displacedExists = await fs
          .lstat(displaced)
          .then(() => true)
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return false;
            throw error;
          });
        if (!write.expectedPreviousSha256) {
          if (displacedExists) {
            throw transactionConflict(
              `Managed file appeared during transaction: ${write.relativePath}`,
            );
          }
          return;
        }
        if (
          !displacedExists ||
          (await sha256File(displaced)) !== write.expectedPreviousSha256
        ) {
          throw transactionConflict(
            `Managed file changed during transaction: ${write.relativePath}`,
          );
        }
      },
    },
  );
  await plan.hooks?.afterMutation?.(mutation);
}

async function applyDeletion(
  deletion: PreparedDelete,
  plan: FilesystemTransactionPlan,
  mutations: TransactionMutation[],
  journal: TransactionJournal,
): Promise<void> {
  const { mutation } = deletion;
  const classification = await classifyInstalledPath(
    mutation.root,
    mutation.relativePath,
    deletion.expectedSha256,
  );
  if (classification.status !== 'owned-clean') {
    throw transactionConflict(`Stale file changed during transaction: ${mutation.relativePath}`);
  }
  await plan.hooks?.beforeMutation?.(mutation);
  mutations.push(mutation);
  const target = await resolveWithinRoot(mutation.root, mutation.relativePath);
  const artifacts = transactionRollbackWriteArtifacts(
    journal,
    mutation.root,
    mutation.relativePath,
  );
  if (!artifacts) throw transactionConflict('Deletion recovery artifact is missing.');
  const displaced = await resolveWithinRoot(
    mutation.root,
    artifacts.displacedRelativePath,
  );
  await displaceFileDurably(target, displaced, async () => {
    if ((await sha256File(displaced)) !== deletion.expectedSha256) {
      throw transactionConflict(
        `Stale file changed during transaction: ${mutation.relativePath}`,
      );
    }
  });
  await plan.hooks?.afterMutation?.(mutation);
}
