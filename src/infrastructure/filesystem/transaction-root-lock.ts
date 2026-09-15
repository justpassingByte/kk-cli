import lockfile from 'proper-lockfile';
import { canonicalizeRoot } from './path-guard.js';
import { transactionConflict } from './transaction-errors.js';

export async function canonicalizeTransactionRoots(roots: string[]): Promise<string[]> {
  if (roots.length === 0) throw transactionConflict('At least one transaction root is required.');
  const canonical = await Promise.all(roots.map((root) => canonicalizeRoot(root)));
  return [...new Set(canonical)].sort((left, right) => left.localeCompare(right));
}

export async function requireTransactionRoot(root: string, roots: string[]): Promise<string> {
  const resolved = await canonicalizeRoot(root);
  const matched = roots.find((candidate) =>
    process.platform === 'win32' ? candidate.toLowerCase() === resolved.toLowerCase() : candidate === resolved,
  );
  if (matched === undefined) throw transactionConflict(`Transaction target uses an unlocked root: ${root}`);
  return matched;
}

export async function revalidateTransactionRoots(roots: string[]): Promise<void> {
  for (const root of roots) {
    if ((await canonicalizeRoot(root)) !== root) {
      throw transactionConflict(`Transaction root changed after locking: ${root}`);
    }
  }
}

export async function acquireTransactionRootLocks(roots: string[]): Promise<Array<() => Promise<void>>> {
  const releases: Array<() => Promise<void>> = [];
  try {
    for (const root of roots) {
      releases.push(
        await lockfile.lock(root, {
          realpath: true,
          stale: 2_000,
          retries: { retries: 24, factor: 1.35, minTimeout: 50, maxTimeout: 250 },
        }),
      );
    }
    return releases;
  } catch (error) {
    await releaseTransactionRootLocks(releases);
    throw transactionConflict('Another lifecycle operation holds a required root lock.', error);
  }
}

export async function releaseTransactionRootLocks(releases: Array<() => Promise<void>>): Promise<void> {
  for (const release of [...releases].reverse()) await release().catch(() => undefined);
}
