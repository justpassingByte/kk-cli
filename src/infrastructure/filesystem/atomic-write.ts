import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureSafeParentDirectories, resolveWithinRoot } from './path-guard.js';

export interface AtomicWritePaths {
  temporaryRelativePath: string;
  displacedRelativePath: string;
}

export interface AtomicWriteHooks {
  afterTemporarySync?: (temporaryPath: string) => void | Promise<void>;
  afterDisplace?: () => void | Promise<void>;
  beforeReplace?: () => void | Promise<void>;
}

export async function atomicWriteFile(
  root: string,
  relativePath: string,
  contents: Uint8Array | string,
  mode = 0o600,
  paths?: AtomicWritePaths,
  hooks?: AtomicWriteHooks,
): Promise<string> {
  const target = await resolveWithinRoot(root, relativePath);
  await ensureSafeParentDirectories(root, target);
  await resolveWithinRoot(root, relativePath);
  const existing = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing !== null && !existing.isFile()) {
    throw new Error(`Atomic write destination is not a regular file: ${target}`);
  }

  const temporary = paths
    ? await resolveSibling(root, target, paths.temporaryRelativePath)
    : path.join(
        path.dirname(target),
        `.${path.basename(target)}.kk-${randomUUID()}.tmp`,
      );
  const displaced = paths
    ? await resolveSibling(root, target, paths.displacedRelativePath)
    : `${target}.kk-swap-${randomUUID()}`;
  const desired = Buffer.isBuffer(contents)
    ? contents
    : typeof contents === 'string'
      ? Buffer.from(contents)
      : Buffer.from(contents);
  let createdTemporary = false;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', mode);
    createdTemporary = true;
    await handle.writeFile(desired);
    await handle.sync();
    await hooks?.afterTemporarySync?.(temporary);
  } catch (error) {
    if (
      !createdTemporary &&
      (error as NodeJS.ErrnoException).code === 'EEXIST'
    ) {
      await assertReusableTemporary(temporary, desired, mode);
    } else {
      await handle?.close().catch(() => undefined);
      if (createdTemporary) {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
      }
      throw error;
    }
  }
  await handle?.close();

  try {
    await replaceFile(temporary, target, displaced, paths !== undefined, hooks);
    if (process.platform !== 'win32') {
      const directory = await fs.open(path.dirname(target), 'r');
      await directory
        .sync()
        .finally(() => directory.close());
    }
  } catch (error) {
    if (!paths) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
    throw error;
  }
  return target;
}

async function replaceFile(
  temporary: string,
  target: string,
  displaced: string,
  retainDisplaced: boolean,
  hooks?: AtomicWriteHooks,
): Promise<void> {
  if (retainDisplaced) {
    await replaceWithoutOverwrite(temporary, target, displaced, hooks);
    return;
  }
  let directReplaceFailed = false;
  try {
    await renameWithWindowsRetry(temporary, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      process.platform !== 'win32' ||
      !['EACCES', 'EBUSY', 'EEXIST', 'EPERM'].includes(code ?? '')
    ) {
      throw error;
    }
    const targetExists = await fs
      .lstat(target)
      .then(() => true)
      .catch((targetError: NodeJS.ErrnoException) => {
        if (targetError.code === 'ENOENT') return false;
        throw targetError;
      });
    if (!targetExists) throw error;
    directReplaceFailed = true;
  }
  if (!directReplaceFailed) {
    await syncFile(target);
    return;
  }

  await renameWithWindowsRetry(target, displaced);
  try {
    await hooks?.afterDisplace?.();
    await renameWithWindowsRetry(temporary, target);
    await syncFile(target);
  } catch (error) {
    await renameWithWindowsRetry(displaced, target).catch(() => undefined);
    throw error;
  }
  await removeWithWindowsRetry(displaced);
}

async function replaceWithoutOverwrite(
  temporary: string,
  target: string,
  displaced: string,
  hooks?: AtomicWriteHooks,
): Promise<void> {
  const targetInfo = await fs
    .lstat(target)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
  let displacedTarget = false;
  if (targetInfo) {
    if (!targetInfo.isFile() || targetInfo.isSymbolicLink()) {
      throw new Error('Atomic write destination changed to a non-regular file.');
    }
    await renameWithWindowsRetry(target, displaced);
    displacedTarget = true;
    await hooks?.afterDisplace?.();
  }

  try {
    await hooks?.beforeReplace?.();
    await retryWindowsSharingViolation(() => fs.link(temporary, target));
    await syncFile(target);
    await removeWithWindowsRetry(temporary);
  } catch (error) {
    if (displacedTarget) {
      const targetExists = await fs
        .lstat(target)
        .then(() => true)
        .catch(() => false);
      if (!targetExists) {
        await renameWithWindowsRetry(displaced, target).catch(() => undefined);
      }
    }
    throw error;
  }
}

async function assertReusableTemporary(
  temporary: string,
  desired: Buffer,
  mode: number,
): Promise<void> {
  const info = await fs.lstat(temporary);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size !== desired.byteLength ||
    (process.platform !== 'win32' && (info.mode & 0o777) !== mode)
  ) {
    throw new Error('Atomic write temporary file cannot be resumed safely.');
  }
  const current = await fs.readFile(temporary);
  if (!current.equals(desired)) {
    throw new Error('Atomic write temporary file has unexpected bytes.');
  }
}

async function syncFile(target: string): Promise<void> {
  // Windows requires a write-capable handle for FlushFileBuffers. POSIX can
  // fsync a read-only handle, which avoids asking for broader permissions.
  const handle = await fs.open(target, process.platform === 'win32' ? 'r+' : 'r');
  await handle.sync().finally(() => handle.close());
}

async function renameWithWindowsRetry(source: string, destination: string): Promise<void> {
  await retryWindowsSharingViolation(() => fs.rename(source, destination));
}

async function removeWithWindowsRetry(target: string): Promise<void> {
  await retryWindowsSharingViolation(() => fs.rm(target, { force: true }));
}

async function retryWindowsSharingViolation<T>(
  action: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        process.platform !== 'win32' ||
        !['EACCES', 'EBUSY', 'EPERM'].includes(code ?? '') ||
        attempt >= 5
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20 * 2 ** attempt));
    }
  }
}

async function resolveSibling(
  root: string,
  target: string,
  relativePath: string,
): Promise<string> {
  const candidate = await resolveWithinRoot(root, relativePath);
  if (path.dirname(candidate) !== path.dirname(target) || candidate === target) {
    throw new Error('Atomic write artifact must be beside its destination.');
  }
  return candidate;
}
