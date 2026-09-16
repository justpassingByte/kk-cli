import fs from 'node:fs/promises';
import path from 'node:path';
import { KkError, EXIT_CODES } from '../../domain/contracts/kk-error.js';

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

function securityError(message: string, details?: Record<string, unknown>): KkError {
  const options: ConstructorParameters<typeof KkError>[1] = {
    code: 'security_error',
    exitCode: EXIT_CODES.security,
    remediation: 'Use a regular path contained by the selected install root.',
  };
  if (details !== undefined) options.details = details;
  return new KkError(message, options);
}

export function assertPortableRelativePath(relativePath: string): void {
  if (
    relativePath.length === 0 ||
    relativePath.includes('\0') ||
    relativePath.includes('\\') ||
    path.posix.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath)
  ) {
    throw securityError(`Unsafe relative path: ${JSON.stringify(relativePath)}`);
  }
  const segments = relativePath.split('/');
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        segment.includes(':') ||
        segment.endsWith('.') ||
        segment.endsWith(' ') ||
        WINDOWS_RESERVED.test(segment),
    )
  ) {
    throw securityError(`Unsafe relative path: ${JSON.stringify(relativePath)}`);
  }
  if (path.posix.normalize(relativePath) !== relativePath) {
    throw securityError(`Non-canonical relative path: ${JSON.stringify(relativePath)}`);
  }
}

export function isPathWithinRoot(
  root: string,
  candidate: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const normalize = (value: string): string =>
    platform === 'win32' ? pathApi.resolve(value).toLowerCase() : pathApi.resolve(value);
  const normalizedRoot = normalize(root);
  const normalizedCandidate = normalize(candidate);
  const relative = pathApi.relative(normalizedRoot, normalizedCandidate);
  return relative === '' || (!pathApi.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${pathApi.sep}`));
}

export async function canonicalizeRoot(root: string): Promise<string> {
  if (!path.isAbsolute(root)) {
    throw securityError(`Transaction root must be absolute: ${root}`);
  }
  const resolved = path.resolve(root);
  if (path.parse(resolved).root === resolved) {
    throw securityError(`Filesystem roots cannot be transaction roots: ${resolved}`);
  }
  const info = await fs.lstat(resolved).catch((error: NodeJS.ErrnoException) => {
    throw securityError(`Transaction root is unavailable: ${resolved}`, { causeCode: error.code });
  });
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw securityError(`Transaction root must be a real directory: ${resolved}`);
  }
  return fs.realpath(resolved);
}

export async function resolveWithinRoot(root: string, relativePath: string): Promise<string> {
  assertPortableRelativePath(relativePath);
  const candidate = path.join(root, ...relativePath.split('/'));
  if (!isPathWithinRoot(root, candidate)) {
    throw securityError(`Path escapes transaction root: ${relativePath}`);
  }

  let current = root;
  for (const segment of relativePath.split('/')) {
    current = path.join(current, segment);
    const info = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (info === null) break;
    if (info.isSymbolicLink()) {
      throw securityError(`Symbolic links are not allowed in managed paths: ${relativePath}`);
    }
  }

  const existingParent = await nearestExistingParent(path.dirname(candidate));
  const canonicalParent = await fs.realpath(existingParent);
  if (!isPathWithinRoot(root, canonicalParent)) {
    throw securityError(`Path resolves outside transaction root: ${relativePath}`);
  }
  return candidate;
}

async function nearestExistingParent(start: string): Promise<string> {
  let current = start;
  while (true) {
    try {
      const info = await fs.lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw securityError(`Managed path parent is not a real directory: ${current}`);
      }
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

export async function ensureSafeParentDirectories(root: string, target: string): Promise<void> {
  const relative = path.relative(root, path.dirname(target));
  if (relative === '') return;
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      const info = await fs.lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw securityError(`Managed path parent is not a real directory: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await fs.mkdir(current, { mode: 0o750 });
    }
  }
  const canonicalParent = await fs.realpath(path.dirname(target));
  if (!isPathWithinRoot(root, canonicalParent)) {
    throw securityError(`Managed path parent resolves outside root: ${target}`);
  }
}
