import type {
  FilesystemTransactionPlan,
  OwnershipClassification,
  TransactionFileWrite,
  TransactionMutation,
} from '../../domain/lifecycle/filesystem-transaction.js';
import { classifyInstalledPath } from '../installed-kits/ownership-classifier.js';
import { sha256Bytes } from './file-hash.js';
import type { SnapshotTarget } from './transaction-snapshot.js';
import { transactionConflict } from './transaction-errors.js';
import { requireTransactionRoot } from './transaction-root-lock.js';

export interface PreparedDelete {
  mutation: TransactionMutation;
  expectedSha256: string;
}

export interface PreparedTransaction {
  writes: Array<{ write: TransactionFileWrite; kind: TransactionMutation['kind'] }>;
  deletes: PreparedDelete[];
  manifestDelete?: PreparedDelete;
  classifications: OwnershipClassification[];
}

export async function prepareFilesystemTransaction(
  plan: FilesystemTransactionPlan,
  roots: string[],
): Promise<PreparedTransaction> {
  const writes = [
    ...plan.writes.map((write) => ({ write, kind: 'write' as const })),
    ...(plan.metadataWrites ?? []).map((write) => ({
      write,
      kind: 'metadata' as const,
    })),
    ...(plan.manifestCommit === undefined ? [] : [{ write: plan.manifestCommit, kind: 'manifest' as const }]),
    ...(plan.registryCommit === undefined ? [] : [{ write: plan.registryCommit, kind: 'registry' as const }]),
  ];
  const normalizedWrites = await Promise.all(
    writes.map(async ({ write, kind }) => ({
      write: { ...write, root: await requireTransactionRoot(write.root, roots) },
      kind,
    })),
  );
  const classifications: OwnershipClassification[] = [];
  const actionableWrites: PreparedTransaction['writes'] = [];
  const seen = new Set<string>();

  for (const pending of normalizedWrites) {
    const key = mutationKey(pending.write.root, pending.write.relativePath);
    if (seen.has(key)) throw transactionConflict(`Duplicate transaction target: ${pending.write.relativePath}`);
    seen.add(key);
    const classification = await classifyInstalledPath(
      pending.write.root,
      pending.write.relativePath,
      pending.write.expectedPreviousSha256,
    );
    classifications.push(classification);
    if (classification.status === 'foreign' || classification.status === 'owned-modified') {
      throw transactionConflict(`Refusing to overwrite ${classification.status} file: ${pending.write.relativePath}`);
    }
    if (classification.actualSha256 !== sha256Bytes(pending.write.contents)) actionableWrites.push(pending);
  }

  const deletes: PreparedDelete[] = [];
  for (const stale of plan.staleFiles ?? []) {
    const root = await requireTransactionRoot(stale.root, roots);
    const key = mutationKey(root, stale.entry.rel_path);
    if (seen.has(key)) continue;
    seen.add(key);
    const classification = await classifyInstalledPath(root, stale.entry.rel_path, stale.entry.sha256);
    classifications.push(classification);
    if (classification.status === 'owned-clean') {
      deletes.push({
        mutation: { kind: 'delete', root, relativePath: stale.entry.rel_path },
        expectedSha256: stale.entry.sha256,
      });
    }
  }
  let manifestDelete: PreparedDelete | undefined;
  if (plan.manifestDelete) {
    const root = await requireTransactionRoot(plan.manifestDelete.root, roots);
    const entry = plan.manifestDelete.entry;
    const key = mutationKey(root, entry.rel_path);
    if (seen.has(key)) throw transactionConflict(`Duplicate transaction target: ${entry.rel_path}`);
    const classification = await classifyInstalledPath(root, entry.rel_path, entry.sha256);
    classifications.push(classification);
    if (classification.status !== 'owned-clean') {
      throw transactionConflict(`Install manifest changed during transaction: ${entry.rel_path}`);
    }
    manifestDelete = {
      mutation: { kind: 'manifest', root, relativePath: entry.rel_path },
      expectedSha256: entry.sha256,
    };
  }
  return {
    writes: actionableWrites,
    deletes,
    classifications,
    ...(manifestDelete ? { manifestDelete } : {}),
  };
}

export function transactionSnapshotTargets(prepared: PreparedTransaction): SnapshotTarget[] {
  return [
    ...prepared.deletes.map(({ mutation: { root, relativePath } }) => ({ root, relativePath })),
    ...(prepared.manifestDelete
      ? [
          {
            root: prepared.manifestDelete.mutation.root,
            relativePath: prepared.manifestDelete.mutation.relativePath,
          },
        ]
      : []),
    ...prepared.writes.map(({ write }) => ({ root: write.root, relativePath: write.relativePath })),
  ];
}

function mutationKey(root: string, relativePath: string): string {
  return `${process.platform === 'win32' ? root.toLowerCase() : root}\0${relativePath}`;
}
