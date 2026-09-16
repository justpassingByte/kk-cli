import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { afterEach, describe, expect, it } from 'vitest';
import { KkError, EXIT_CODES } from '../../src/domain/contracts/kk-error.js';
import type { FilesystemTransactionPlan } from '../../src/domain/lifecycle/filesystem-transaction.js';
import { sha256Bytes } from '../../src/infrastructure/filesystem/file-hash.js';
import { LocalFilesystemTransaction } from '../../src/infrastructure/filesystem/local-filesystem-transaction.js';
import { writeRecoveryReceipt } from '../../src/infrastructure/filesystem/recovery-receipt.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<{ base: string; root: string; snapshots: string; recovery: string }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'kk-transaction-test-'));
  temporaryDirectories.push(base);
  const root = path.join(base, 'root');
  const snapshots = path.join(base, 'snapshots');
  const recovery = path.join(base, 'recovery');
  await fs.mkdir(root);
  return { base: await fs.realpath(base), root: await fs.realpath(root), snapshots, recovery };
}

function planFor(
  paths: Awaited<ReturnType<typeof fixture>>,
  overrides: Partial<FilesystemTransactionPlan>,
): FilesystemTransactionPlan {
  return {
    roots: [paths.root],
    snapshotDirectory: paths.snapshots,
    recoveryDirectory: paths.recovery,
    writes: [],
    ...overrides,
  };
}

describe('LocalFilesystemTransaction', () => {
  it('snapshots first, deletes only clean stale files, and commits metadata last', async () => {
    const paths = await fixture();
    await fs.writeFile(path.join(paths.root, 'payload.txt'), 'old');
    await fs.writeFile(path.join(paths.root, 'stale-clean.txt'), 'clean');
    await fs.writeFile(path.join(paths.root, 'stale-modified.txt'), 'user-edit');
    await fs.writeFile(path.join(paths.root, 'manifest.json'), 'old-manifest');
    await fs.writeFile(path.join(paths.root, 'registry.json'), 'old-registry');
    const phases: string[] = [];
    let lockObserved = false;

    const result = await new LocalFilesystemTransaction().run(
      planFor(paths, {
        writes: [
          {
            root: paths.root,
            relativePath: 'payload.txt',
            contents: 'new',
            expectedPreviousSha256: sha256Bytes('old'),
          },
        ],
        staleFiles: [
          { root: paths.root, entry: { rel_path: 'stale-clean.txt', sha256: sha256Bytes('clean') } },
          { root: paths.root, entry: { rel_path: 'stale-modified.txt', sha256: sha256Bytes('original') } },
        ],
        manifestCommit: {
          root: paths.root,
          relativePath: 'manifest.json',
          contents: 'new-manifest',
          expectedPreviousSha256: sha256Bytes('old-manifest'),
        },
        registryCommit: {
          root: paths.root,
          relativePath: 'registry.json',
          contents: 'new-registry',
          expectedPreviousSha256: sha256Bytes('old-registry'),
        },
        hooks: {
          revalidate: async () => {
            lockObserved = await lockfile.check(paths.root, { realpath: true });
            phases.push('revalidate');
          },
          afterSnapshot: () => {
            phases.push('snapshot');
          },
          afterMutation: (mutation) => {
            phases.push(mutation.kind);
          },
        },
      }),
    );

    expect(await fs.readFile(path.join(paths.root, 'payload.txt'), 'utf8')).toBe('new');
    await expect(fs.stat(path.join(paths.root, 'stale-clean.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(path.join(paths.root, 'stale-modified.txt'), 'utf8')).toBe('user-edit');
    expect(await fs.readFile(path.join(paths.root, 'manifest.json'), 'utf8')).toBe('new-manifest');
    expect(await fs.readFile(path.join(paths.root, 'registry.json'), 'utf8')).toBe('new-registry');
    expect(phases).toEqual(['revalidate', 'snapshot', 'delete', 'write', 'manifest', 'registry']);
    expect(lockObserved).toBe(true);
    expect(result.classifications).toContainEqual(
      expect.objectContaining({ relativePath: 'stale-modified.txt', status: 'owned-modified' }),
    );
    await expect(fs.stat(path.join(result.snapshotPath, 'snapshot.json'))).resolves.toBeDefined();
  });

  it('rolls payload changes back when an injected later write fails', async () => {
    const paths = await fixture();
    await fs.writeFile(path.join(paths.root, 'first.txt'), 'before');

    await expect(
      new LocalFilesystemTransaction().run(
        planFor(paths, {
          writes: [
            {
              root: paths.root,
              relativePath: 'first.txt',
              contents: 'after',
              expectedPreviousSha256: sha256Bytes('before'),
            },
            { root: paths.root, relativePath: 'second.txt', contents: 'second' },
          ],
          hooks: {
            beforeMutation: (mutation) => {
              if (mutation.relativePath === 'second.txt') throw new Error('injected write failure');
            },
          },
        }),
      ),
    ).rejects.toThrow('injected write failure');

    expect(await fs.readFile(path.join(paths.root, 'first.txt'), 'utf8')).toBe('before');
    await expect(fs.stat(path.join(paths.root, 'second.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('applies and verifies an external step after payload writes and before metadata commits', async () => {
    const paths = await fixture();
    await fs.writeFile(path.join(paths.root, 'payload.txt'), 'old');
    await fs.writeFile(path.join(paths.root, 'manifest.json'), 'old-manifest');
    await fs.writeFile(path.join(paths.root, 'registry.json'), 'old-registry');
    const phases: string[] = [];

    await new LocalFilesystemTransaction().run(
      planFor(paths, {
        writes: [
          {
            root: paths.root,
            relativePath: 'payload.txt',
            contents: 'new',
            expectedPreviousSha256: sha256Bytes('old'),
          },
        ],
        manifestCommit: {
          root: paths.root,
          relativePath: 'manifest.json',
          contents: 'new-manifest',
          expectedPreviousSha256: sha256Bytes('old-manifest'),
        },
        registryCommit: {
          root: paths.root,
          relativePath: 'registry.json',
          contents: 'new-registry',
          expectedPreviousSha256: sha256Bytes('old-registry'),
        },
        externalStep: {
          apply: () => {
            phases.push('external-apply');
          },
          verify: () => {
            phases.push('external-verify');
          },
          compensate: () => {
            phases.push('external-compensate');
          },
        },
        hooks: {
          afterMutation: (mutation) => {
            phases.push(mutation.kind);
          },
        },
      }),
    );

    expect(phases).toEqual(['write', 'external-apply', 'external-verify', 'manifest', 'registry']);
    expect(await fs.readFile(path.join(paths.root, 'payload.txt'), 'utf8')).toBe('new');
    expect(await fs.readFile(path.join(paths.root, 'manifest.json'), 'utf8')).toBe('new-manifest');
    expect(await fs.readFile(path.join(paths.root, 'registry.json'), 'utf8')).toBe('new-registry');
  });

  it('compensates an apply failure before rolling payload writes back and leaves metadata untouched', async () => {
    const paths = await fixture();
    await fs.writeFile(path.join(paths.root, 'payload.txt'), 'old');
    await fs.writeFile(path.join(paths.root, 'manifest.json'), 'old-manifest');
    await fs.writeFile(path.join(paths.root, 'registry.json'), 'old-registry');
    const phases: string[] = [];

    await expect(
      new LocalFilesystemTransaction().run(
        planFor(paths, {
          writes: [
            {
              root: paths.root,
              relativePath: 'payload.txt',
              contents: 'new',
              expectedPreviousSha256: sha256Bytes('old'),
            },
          ],
          manifestCommit: {
            root: paths.root,
            relativePath: 'manifest.json',
            contents: 'new-manifest',
            expectedPreviousSha256: sha256Bytes('old-manifest'),
          },
          registryCommit: {
            root: paths.root,
            relativePath: 'registry.json',
            contents: 'new-registry',
            expectedPreviousSha256: sha256Bytes('old-registry'),
          },
          externalStep: {
            apply: () => {
              phases.push('external-apply');
              throw new Error('activation failed');
            },
            verify: () => {
              phases.push('external-verify');
            },
            compensate: () => {
              phases.push('external-compensate');
            },
          },
          hooks: {
            beforeRollback: () => {
              phases.push('filesystem-rollback');
            },
          },
        }),
      ),
    ).rejects.toThrow('activation failed');

    expect(phases).toEqual(['external-apply', 'external-compensate', 'filesystem-rollback']);
    expect(await fs.readFile(path.join(paths.root, 'payload.txt'), 'utf8')).toBe('old');
    expect(await fs.readFile(path.join(paths.root, 'manifest.json'), 'utf8')).toBe('old-manifest');
    expect(await fs.readFile(path.join(paths.root, 'registry.json'), 'utf8')).toBe('old-registry');
  });

  it('compensates a verification failure and restores payload writes', async () => {
    const paths = await fixture();
    await fs.writeFile(path.join(paths.root, 'payload.txt'), 'old');
    let activated = false;

    await expect(
      new LocalFilesystemTransaction().run(
        planFor(paths, {
          writes: [
            {
              root: paths.root,
              relativePath: 'payload.txt',
              contents: 'new',
              expectedPreviousSha256: sha256Bytes('old'),
            },
          ],
          externalStep: {
            apply: () => {
              activated = true;
            },
            verify: () => {
              throw new Error('activation not observable');
            },
            compensate: () => {
              activated = false;
            },
          },
        }),
      ),
    ).rejects.toThrow('activation not observable');

    expect(activated).toBe(false);
    expect(await fs.readFile(path.join(paths.root, 'payload.txt'), 'utf8')).toBe('old');
  });

  it('records actionable external evidence when compensation fails', async () => {
    const paths = await fixture();
    await fs.writeFile(path.join(paths.root, 'payload.txt'), 'old');
    let caught: unknown;
    const applyFailure = new KkError('plugin registration failed', {
      code: 'unsupported_environment',
      exitCode: EXIT_CODES.dependency,
      remediation: 'Install or update the Claude Code CLI.',
      details: { provider: 'claude-code' },
    });
    const compensationFailure = new KkError('plugin unregister failed', {
      code: 'permission_denied',
      exitCode: EXIT_CODES.security,
      remediation: 'Remove the plugin registration manually.',
    });

    try {
      await new LocalFilesystemTransaction().run(
        planFor(paths, {
          writes: [
            {
              root: paths.root,
              relativePath: 'payload.txt',
              contents: 'new',
              expectedPreviousSha256: sha256Bytes('old'),
            },
          ],
          externalStep: {
            id: 'claude-code:project-plugin:ak-engineer@agentkit-local',
            apply: () => {
              throw applyFailure;
            },
            verify: () => undefined,
            compensate: () => {
              throw compensationFailure;
            },
          },
        }),
      );
    } catch (error) {
      caught = error;
    }

    const receiptPath = (caught as { details?: { recoveryReceiptPath?: string } }).details?.recoveryReceiptPath;
    expect(receiptPath).toBeTypeOf('string');
    expect(caught).toMatchObject({
      code: 'unsupported_environment',
      exitCode: EXIT_CODES.dependency,
      remediation: expect.stringContaining('Install or update the Claude Code CLI.'),
      details: expect.objectContaining({ provider: 'claude-code' }),
    });
    expect(await fs.readFile(path.join(paths.root, 'payload.txt'), 'utf8')).toBe('old');
    const receipt = JSON.parse(await fs.readFile(receiptPath as string, 'utf8'));
    expect(receipt.failureCount).toBe(0);
    expect(receipt.externalFailureCount).toBe(2);
    expect(receipt.externalFailures).toEqual([
      {
        phase: 'apply',
        error: 'plugin registration failed',
        stepId: 'claude-code:project-plugin:ak-engineer@agentkit-local',
        code: 'unsupported_environment',
        remediation: 'Install or update the Claude Code CLI.',
      },
      {
        phase: 'compensate',
        error: 'plugin unregister failed',
        stepId: 'claude-code:project-plugin:ak-engineer@agentkit-local',
        code: 'permission_denied',
        remediation: 'Remove the plugin registration manually.',
      },
    ]);
  });

  it('compensates a verified external step when a later metadata commit fails', async () => {
    const paths = await fixture();
    await fs.writeFile(path.join(paths.root, 'payload.txt'), 'old');
    await fs.writeFile(path.join(paths.root, 'manifest.json'), 'old-manifest');
    await fs.writeFile(path.join(paths.root, 'registry.json'), 'old-registry');
    const phases: string[] = [];

    await expect(
      new LocalFilesystemTransaction().run(
        planFor(paths, {
          writes: [
            {
              root: paths.root,
              relativePath: 'payload.txt',
              contents: 'new',
              expectedPreviousSha256: sha256Bytes('old'),
            },
          ],
          manifestCommit: {
            root: paths.root,
            relativePath: 'manifest.json',
            contents: 'new-manifest',
            expectedPreviousSha256: sha256Bytes('old-manifest'),
          },
          registryCommit: {
            root: paths.root,
            relativePath: 'registry.json',
            contents: 'new-registry',
            expectedPreviousSha256: sha256Bytes('old-registry'),
          },
          externalStep: {
            apply: () => {
              phases.push('external-apply');
            },
            verify: () => {
              phases.push('external-verify');
            },
            compensate: () => {
              phases.push('external-compensate');
            },
          },
          hooks: {
            beforeMutation: (mutation) => {
              if (mutation.kind === 'registry') throw new Error('registry commit failed');
            },
            beforeRollback: (mutation) => {
              phases.push(`rollback-${mutation.kind}`);
            },
          },
        }),
      ),
    ).rejects.toThrow('registry commit failed');

    expect(phases).toEqual([
      'external-apply',
      'external-verify',
      'external-compensate',
      'rollback-manifest',
      'rollback-write',
    ]);
    expect(await fs.readFile(path.join(paths.root, 'payload.txt'), 'utf8')).toBe('old');
    expect(await fs.readFile(path.join(paths.root, 'manifest.json'), 'utf8')).toBe('old-manifest');
    expect(await fs.readFile(path.join(paths.root, 'registry.json'), 'utf8')).toBe('old-registry');
  });

  it('can apply and verify an external step before any filesystem mutation', async () => {
    const paths = await fixture();
    await fs.writeFile(path.join(paths.root, 'source.txt'), 'owned-source');
    await fs.writeFile(path.join(paths.root, 'manifest.json'), 'old-manifest');
    await fs.writeFile(path.join(paths.root, 'registry.json'), 'old-registry');
    const phases: string[] = [];

    await new LocalFilesystemTransaction().run(
      planFor(paths, {
        staleFiles: [
          {
            root: paths.root,
            entry: { rel_path: 'source.txt', sha256: sha256Bytes('owned-source') },
          },
        ],
        manifestDelete: {
          root: paths.root,
          entry: { rel_path: 'manifest.json', sha256: sha256Bytes('old-manifest') },
        },
        registryCommit: {
          root: paths.root,
          relativePath: 'registry.json',
          contents: 'new-registry',
          expectedPreviousSha256: sha256Bytes('old-registry'),
        },
        externalStep: {
          position: 'before-mutations',
          compensateAfterRollback: true,
          apply: () => {
            phases.push('external-apply');
          },
          verify: () => {
            phases.push('external-verify');
          },
          compensate: () => {
            phases.push('external-compensate');
          },
        },
        hooks: {
          afterMutation: (mutation) => {
            phases.push(mutation.kind);
          },
        },
      }),
    );

    expect(phases).toEqual(['external-apply', 'external-verify', 'delete', 'manifest', 'registry']);
    await expect(fs.stat(path.join(paths.root, 'source.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(paths.root, 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(path.join(paths.root, 'registry.json'), 'utf8')).toBe('new-registry');
  });

  it('restores deleted source files before compensating a before-mutations external step', async () => {
    const paths = await fixture();
    await fs.writeFile(path.join(paths.root, 'source.txt'), 'owned-source');
    await fs.writeFile(path.join(paths.root, 'manifest.json'), 'old-manifest');
    await fs.writeFile(path.join(paths.root, 'registry.json'), 'old-registry');
    const phases: string[] = [];

    await expect(
      new LocalFilesystemTransaction().run(
        planFor(paths, {
          staleFiles: [
            {
              root: paths.root,
              entry: { rel_path: 'source.txt', sha256: sha256Bytes('owned-source') },
            },
          ],
          manifestDelete: {
            root: paths.root,
            entry: { rel_path: 'manifest.json', sha256: sha256Bytes('old-manifest') },
          },
          registryCommit: {
            root: paths.root,
            relativePath: 'registry.json',
            contents: 'new-registry',
            expectedPreviousSha256: sha256Bytes('old-registry'),
          },
          externalStep: {
            position: 'before-mutations',
            compensateAfterRollback: true,
            apply: () => {
              phases.push('external-apply');
            },
            verify: () => {
              phases.push('external-verify');
            },
            compensate: async () => {
              phases.push('external-compensate');
              expect(await fs.readFile(path.join(paths.root, 'source.txt'), 'utf8')).toBe(
                'owned-source',
              );
            },
          },
          hooks: {
            afterMutation: (mutation) => {
              phases.push(mutation.kind);
            },
            beforeMutation: (mutation) => {
              if (mutation.kind === 'registry') throw new Error('registry commit failed');
            },
            beforeRollback: (mutation) => {
              phases.push(`rollback-${mutation.kind}`);
            },
          },
        }),
      ),
    ).rejects.toThrow('registry commit failed');

    expect(phases).toEqual([
      'external-apply',
      'external-verify',
      'delete',
      'manifest',
      'rollback-manifest',
      'rollback-delete',
      'external-compensate',
    ]);
    expect(await fs.readFile(path.join(paths.root, 'source.txt'), 'utf8')).toBe('owned-source');
    expect(await fs.readFile(path.join(paths.root, 'manifest.json'), 'utf8')).toBe('old-manifest');
    expect(await fs.readFile(path.join(paths.root, 'registry.json'), 'utf8')).toBe('old-registry');
  });

  it('writes a bounded recovery receipt when rollback is incomplete', async () => {
    const paths = await fixture();
    let caught: unknown;
    try {
      await new LocalFilesystemTransaction().run(
        planFor(paths, {
          writes: [
            { root: paths.root, relativePath: 'first.txt', contents: 'new' },
            { root: paths.root, relativePath: 'second.txt', contents: 'new' },
          ],
          hooks: {
            beforeMutation: (mutation) => {
              if (mutation.relativePath === 'second.txt') throw new Error('injected terminal failure');
            },
            beforeRollback: () => {
              throw new Error('injected rollback failure');
            },
          },
        }),
      );
    } catch (error) {
      caught = error;
    }

    const receiptPath = (caught as { details?: { recoveryReceiptPath?: string } }).details?.recoveryReceiptPath;
    expect(receiptPath).toBeTypeOf('string');
    const receipt = JSON.parse(await fs.readFile(receiptPath as string, 'utf8'));
    expect(receipt.failureCount).toBe(1);
    expect(receipt.failures).toHaveLength(1);
    expect(receipt.truncated).toBe(false);
  });

  it('caps recovery receipt details without losing the total failure count', async () => {
    const paths = await fixture();
    const failures = Array.from({ length: 105 }, (_, index) => ({
      mutation: {
        kind: 'write' as const,
        root: paths.root,
        relativePath: `file-${index.toString().padStart(3, '0')}.txt`,
      },
      error: 'rollback failed',
    }));

    const receiptPath = await writeRecoveryReceipt({
      recoveryDirectory: paths.recovery,
      transactionId: 'bounded-receipt',
      snapshotPath: paths.snapshots,
      failures,
    });
    const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
    expect(receipt.failureCount).toBe(105);
    expect(receipt.failures).toHaveLength(100);
    expect(receipt.truncated).toBe(true);
  });

  it('refuses traversal before mutating the root', async () => {
    const paths = await fixture();
    await expect(
      new LocalFilesystemTransaction().run(
        planFor(paths, {
          writes: [{ root: paths.root, relativePath: '../outside.txt', contents: 'bad' }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'security_error' });
    await expect(fs.stat(path.join(paths.base, 'outside.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(process.platform === 'win32')('refuses a symlinked mutation path', async () => {
    const paths = await fixture();
    const outside = path.join(paths.base, 'outside');
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(paths.root, 'linked'));

    await expect(
      new LocalFilesystemTransaction().run(
        planFor(paths, {
          writes: [{ root: paths.root, relativePath: 'linked/file.txt', contents: 'bad' }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'security_error' });
    await expect(fs.stat(path.join(outside, 'file.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
