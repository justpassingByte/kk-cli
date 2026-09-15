import fs from 'node:fs/promises';
import path from 'node:path';
import type { TransactionMutation } from '../../domain/lifecycle/filesystem-transaction.js';
import {
  atomicWriteFile,
  type AtomicWriteHooks,
  type AtomicWritePaths,
} from './atomic-write.js';
import { isSha256, sha256Bytes, sha256File } from './file-hash.js';
import {
  displaceFileDurably,
  removeFileDurably,
} from './durable-file-removal.js';
import {
  assertPortableRelativePath,
  canonicalizeRoot,
  resolveWithinRoot,
} from './path-guard.js';

export interface SnapshotTarget {
  root: string;
  relativePath: string;
}

export interface SnapshotEntry extends SnapshotTarget {
  existed: boolean;
  mode?: number;
  size?: number;
  backupFile?: string;
  sha256?: string;
}

const MAX_SNAPSHOT_METADATA_BYTES = 8 * 1024 * 1024;

export async function loadTransactionSnapshot(
  snapshotPath: string,
): Promise<TransactionSnapshot> {
  const root = await canonicalizeRoot(snapshotPath);
  const snapshotFile = await resolveWithinRoot(root, 'snapshot.json');
  const info = await fs.lstat(snapshotFile);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error('Transaction snapshot metadata is not a regular file.');
  }
  if (info.size > MAX_SNAPSHOT_METADATA_BYTES) {
    throw new Error('Transaction snapshot metadata is too large.');
  }
  const value = JSON.parse(await fs.readFile(snapshotFile, 'utf8')) as unknown;
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.transactionId !== 'string' ||
    typeof value.createdAt !== 'string' ||
    !Array.isArray(value.entries) ||
    value.entries.length > 100_000
  ) {
    throw new Error('Transaction snapshot metadata is invalid.');
  }
  const seen = new Set<string>();
  const entries = value.entries.map((raw, index): SnapshotEntry => {
    if (
      !isRecord(raw) ||
      typeof raw.root !== 'string' ||
      !path.isAbsolute(raw.root) ||
      typeof raw.relativePath !== 'string' ||
      typeof raw.existed !== 'boolean'
    ) {
      throw new Error(`Transaction snapshot entry ${index} is invalid.`);
    }
    assertPortableRelativePath(raw.relativePath);
    const key = targetKey({
      root: path.resolve(raw.root),
      relativePath: raw.relativePath,
    });
    if (seen.has(key)) throw new Error('Transaction snapshot has duplicate targets.');
    seen.add(key);
    if (!raw.existed) {
      return {
        root: path.resolve(raw.root),
        relativePath: raw.relativePath,
        existed: false,
      };
    }
    if (
      typeof raw.backupFile !== 'string' ||
      raw.backupFile !== `data/${index.toString(16).padStart(8, '0')}` ||
      typeof raw.sha256 !== 'string' ||
      !isSha256(raw.sha256) ||
      typeof raw.mode !== 'number' ||
      !Number.isSafeInteger(raw.mode) ||
      raw.mode < 0 ||
      raw.mode > 0o777 ||
      typeof raw.size !== 'number' ||
      !Number.isSafeInteger(raw.size) ||
      raw.size < 0
    ) {
      throw new Error(`Transaction snapshot entry ${index} is incomplete.`);
    }
    return {
      root: path.resolve(raw.root),
      relativePath: raw.relativePath,
      existed: true,
      backupFile: raw.backupFile,
      sha256: raw.sha256,
      mode: raw.mode,
      size: raw.size,
    };
  });
  return {
    version: 1,
    transactionId: value.transactionId,
    createdAt: value.createdAt,
    entries,
  };
}

export interface TransactionSnapshot {
  version: 1;
  transactionId: string;
  createdAt: string;
  entries: SnapshotEntry[];
}

export async function captureTransactionSnapshot(
  snapshotDirectory: string,
  transactionId: string,
  targets: SnapshotTarget[],
): Promise<{ path: string; snapshot: TransactionSnapshot }> {
  await fs.mkdir(snapshotDirectory, { recursive: true, mode: 0o700 });
  const canonicalStore = await canonicalizeRoot(snapshotDirectory);
  const snapshotPath = await fs.mkdtemp(path.join(canonicalStore, `transaction-${transactionId}-`));
  if (process.platform !== 'win32') {
    const storeDirectory = await fs.open(canonicalStore, 'r');
    await storeDirectory.sync().finally(() => storeDirectory.close());
  }
  const dataPath = path.join(snapshotPath, 'data');
  await fs.mkdir(dataPath, { mode: 0o700 });

  const entries: SnapshotEntry[] = [];
  for (const [index, target] of targets.entries()) {
    const absolute = await resolveWithinRoot(target.root, target.relativePath);
    const info = await fs.lstat(absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (info === null) {
      entries.push({ ...target, existed: false });
      continue;
    }
    if (!info.isFile()) {
      throw new Error(`Cannot snapshot non-regular managed path: ${absolute}`);
    }
    const backupFile = `data/${index.toString(16).padStart(8, '0')}`;
    const backupAbsolute = path.join(snapshotPath, backupFile);
    await fs.copyFile(absolute, backupAbsolute, fs.constants.COPYFILE_EXCL);
    // Windows requires a write-capable handle for FlushFileBuffers.
    const backupHandle = await fs.open(
      backupAbsolute,
      process.platform === 'win32' ? 'r+' : 'r',
    );
    await backupHandle.sync().finally(() => backupHandle.close());
    const backupHash = await sha256File(backupAbsolute);
    if ((await sha256File(absolute)) !== backupHash) {
      throw new Error(`Managed file changed while snapshotting: ${absolute}`);
    }
    entries.push({
      ...target,
      existed: true,
      mode: info.mode & 0o777,
      size: info.size,
      backupFile,
      sha256: backupHash,
    });
  }

  const snapshot: TransactionSnapshot = {
    version: 1,
    transactionId,
    createdAt: new Date().toISOString(),
    entries,
  };
  if (process.platform !== 'win32') {
    const dataDirectory = await fs.open(dataPath, 'r');
    await dataDirectory.sync().finally(() => dataDirectory.close());
  }
  const snapshotRoot = await canonicalizeRoot(snapshotPath);
  await atomicWriteFile(snapshotRoot, 'snapshot.json', `${JSON.stringify(snapshot, null, 2)}\n`);
  return { path: snapshotPath, snapshot };
}

export async function restoreTransactionSnapshot(
  snapshotPath: string,
  snapshot: TransactionSnapshot,
  mutations: TransactionMutation[],
  beforeRollback?: (mutation: TransactionMutation) => void | Promise<void>,
  atomicPaths?: (mutation: TransactionMutation) => AtomicWritePaths | undefined,
  atomicHooks?: (mutation: TransactionMutation) => AtomicWriteHooks | undefined,
): Promise<Array<{ mutation: TransactionMutation; error: string }>> {
  const failures: Array<{ mutation: TransactionMutation; error: string }> = [];
  const byTarget = new Map(snapshot.entries.map((entry) => [targetKey(entry), entry]));

  for (const mutation of [...mutations].reverse()) {
    try {
      await beforeRollback?.(mutation);
      const entry = byTarget.get(targetKey(mutation));
      if (entry === undefined) throw new Error('Snapshot entry is missing.');
      const target = await resolveWithinRoot(entry.root, entry.relativePath);
      const hooks = atomicHooks?.(mutation);
      if (!entry.existed) {
        const info = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (info?.isSymbolicLink()) throw new Error('Refusing to remove a rollback-time symbolic link.');
        if (info !== null && !info.isFile()) throw new Error('Refusing to remove a rollback-time non-file.');
        const paths = atomicPaths?.(mutation);
        if (info !== null && paths) {
          const displaced = await resolveWithinRoot(
            entry.root,
            paths.displacedRelativePath,
          );
          await displaceFileDurably(target, displaced, async () => {
            await hooks?.afterDisplace?.();
            await hooks?.beforeReplace?.();
          });
        } else if (info !== null) {
          await removeFileDurably(target);
        } else {
          await hooks?.beforeReplace?.();
        }
        continue;
      }
      if (
        entry.backupFile === undefined ||
        entry.sha256 === undefined ||
        entry.size === undefined
      ) {
        throw new Error('Snapshot preimage metadata is incomplete.');
      }
      const backupAbsolute = path.join(snapshotPath, entry.backupFile);
      const backupInfo = await fs.lstat(backupAbsolute);
      if (
        !backupInfo.isFile() ||
        backupInfo.isSymbolicLink() ||
        backupInfo.size !== entry.size
      ) {
        throw new Error('Snapshot preimage file is invalid.');
      }
      const contents = await fs.readFile(backupAbsolute);
      if (contents.byteLength !== entry.size) {
        throw new Error('Snapshot preimage size mismatch.');
      }
      if (sha256Bytes(contents) !== entry.sha256) throw new Error('Snapshot preimage hash mismatch.');
      await atomicWriteFile(
        entry.root,
        entry.relativePath,
        contents,
        entry.mode,
        atomicPaths?.(mutation),
        hooks,
      );
    } catch (error) {
      failures.push({
        mutation,
        error: error instanceof Error ? error.message : 'Unknown rollback failure',
      });
    }
  }
  return failures;
}

function targetKey(target: SnapshotTarget): string {
  return `${process.platform === 'win32' ? target.root.toLowerCase() : target.root}\0${target.relativePath}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
