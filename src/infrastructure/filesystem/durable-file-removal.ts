import fs from 'node:fs/promises';
import path from 'node:path';

export async function removeFileDurably(
  target: string,
  options: { force?: boolean } = {},
): Promise<void> {
  await removeWithRetry(target, options.force ?? false);
  if (process.platform === 'win32') return;
  const directory = await fs
    .open(path.dirname(target), 'r')
    .catch((error: NodeJS.ErrnoException) => {
      if (options.force && error.code === 'ENOENT') return null;
      throw error;
    });
  if (!directory) return;
  await directory.sync().finally(() => directory.close());
}

export async function displaceFileDurably(
  target: string,
  displaced: string,
  validate: () => void | Promise<void>,
): Promise<void> {
  await retryWindowsSharingViolation(() => fs.rename(target, displaced));
  await syncParentDirectory(target);
  try {
    await validate();
  } catch (error) {
    const targetExists = await fs
      .lstat(target)
      .then(() => true)
      .catch(() => false);
    if (!targetExists) {
      await retryWindowsSharingViolation(() => fs.link(displaced, target))
        .then(() => syncParentDirectory(target))
        .catch(() => undefined);
    }
    throw error;
  }
}

async function removeWithRetry(target: string, force: boolean): Promise<void> {
  await retryWindowsSharingViolation(() => fs.rm(target, { force }));
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

async function syncParentDirectory(target: string): Promise<void> {
  if (process.platform === 'win32') return;
  const directory = await fs.open(path.dirname(target), 'r');
  await directory.sync().finally(() => directory.close());
}
