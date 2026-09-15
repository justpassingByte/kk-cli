import fs from 'node:fs/promises';
import { AkError, EXIT_CODES } from '../../domain/contracts/ak-error.js';
import type {
  OwnershipClassification,
  OwnershipStatus,
} from '../../domain/lifecycle/filesystem-transaction.js';
import { isSha256, sha256File } from '../filesystem/file-hash.js';
import { resolveWithinRoot } from '../filesystem/path-guard.js';

export async function classifyInstalledPath(
  root: string,
  relativePath: string,
  expectedSha256?: string,
): Promise<OwnershipClassification> {
  const normalizedExpected = expectedSha256?.toLowerCase();
  if (normalizedExpected !== undefined && !isSha256(normalizedExpected)) {
    throw new AkError(`Invalid ownership hash for ${relativePath}.`, {
      code: 'security_error',
      exitCode: EXIT_CODES.security,
      remediation: 'Repair the installed-kit ownership metadata before retrying.',
    });
  }
  const target = await resolveWithinRoot(root, relativePath);
  const info = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });

  let status: OwnershipStatus;
  let actualSha256: string | undefined;
  if (info === null) {
    status = 'missing';
  } else if (!info.isFile()) {
    status = 'foreign';
  } else if (normalizedExpected === undefined) {
    status = 'foreign';
    actualSha256 = await sha256File(target);
  } else {
    actualSha256 = await sha256File(target);
    status = actualSha256 === normalizedExpected ? 'owned-clean' : 'owned-modified';
  }

  const result: OwnershipClassification = { root, relativePath, status };
  if (normalizedExpected !== undefined) result.expectedSha256 = normalizedExpected;
  if (actualSha256 !== undefined) result.actualSha256 = actualSha256;
  return result;
}
