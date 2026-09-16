import fs from 'node:fs/promises';
import path from 'node:path';
import { KkError, EXIT_CODES } from '../../src/domain/contracts/kk-error.js';
import { sha256Bytes } from '../../src/infrastructure/filesystem/file-hash.js';
import { LocalFilesystemTransaction } from '../../src/infrastructure/filesystem/local-filesystem-transaction.js';

const [mode, root, snapshots, recovery, point = ''] = process.argv.slice(2);
if (!mode || !root || !snapshots || !recovery) {
  throw new Error('Missing transaction crash worker arguments.');
}

const managedRoot = root;
const snapshotDirectory = snapshots;
const recoveryDirectory = recovery;
const providerPath = path.join(managedRoot, 'provider-state.json');

if (mode === 'recover') {
  const transaction = new LocalFilesystemTransaction(
    async (descriptor, direction) => {
      if (point === 'provider-fail') {
        throw new KkError('injected provider recovery failure', {
          code: 'conflict',
          exitCode: EXIT_CODES.conflict,
          remediation: 'Review provider state before retrying recovery.',
        });
      }
      if (point === 'provider-crash') await killNow();
      const desired =
        direction === 'rollback' ? descriptor.before : descriptor.after;
      await fs.writeFile(providerPath, `${JSON.stringify(desired)}\n`);
    },
    {
      afterRollbackPhasePersisted: async () => {
        if (point === 'recovery-after-phase') await killNow();
      },
      afterRollbackTemporarySync: async () => {
        if (point === 'recovery-after-temp-sync') await killNow();
      },
      afterRollbackDisplace: async () => {
        if (point === 'recovery-after-displace') await killNow();
      },
      afterFilesystemRestored: async () => {
        if (point === 'recovery-after-restore') await killNow();
      },
      afterRollbackArtifactRemoval: async () => {
        if (point === 'recovery-mid-cleanup') await killNow();
      },
    },
  );
  const recovered = await transaction.recover(
    snapshotDirectory,
    recoveryDirectory,
  );
  process.stdout.write(`${JSON.stringify(recovered)}\n`);
} else if (mode === 'crash') {
  await runCrashTransaction();
} else {
  throw new Error(`Unknown worker mode: ${mode}`);
}

async function runCrashTransaction(): Promise<void> {
  let mutationCount = 0;
  const external =
    point === 'after-provider'
      ? {
          recovery: {
            kind: 'claude-code-project-plugin' as const,
            operation: 'install' as const,
            marketplaceMutation: 'add' as const,
            projectRoot: managedRoot,
            pluginReference: 'ak-engineer@agentkit-local',
            marketplaceBeforeAbsent: true as const,
            marketplaceAfterSha256: 'a'.repeat(64),
            before: {
              pluginInstalled: false,
              pluginEnabled: false,
              marketplaceKnown: false,
              marketplaceConflict: false,
              marketplaceHasOtherPlugins: false,
              marketplaceOtherPlugins: [],
            },
            after: {
              pluginInstalled: true,
              pluginEnabled: true,
              pluginVersion: '1.2.3',
              marketplaceKnown: true,
              marketplaceConflict: false,
              marketplaceHasOtherPlugins: false,
              marketplaceOtherPlugins: [],
            },
          },
          apply: async () => {
            await fs.writeFile(
              providerPath,
              `${JSON.stringify({
                pluginInstalled: true,
                pluginEnabled: true,
                pluginVersion: '1.2.3',
                marketplaceKnown: true,
                marketplaceConflict: false,
                marketplaceHasOtherPlugins: false,
                marketplaceOtherPlugins: [],
              })}\n`,
            );
            await killNow();
          },
          verify: async () => undefined,
          compensate: async () => undefined,
        }
      : undefined;
  await new LocalFilesystemTransaction().run({
    roots: [managedRoot],
    snapshotDirectory,
    recoveryDirectory,
    staleFiles: [
      {
        root: managedRoot,
        entry: { rel_path: 'delete.txt', sha256: sha256Bytes('old-delete') },
      },
    ],
    writes: [
      {
        root: managedRoot,
        relativePath: 'payload.txt',
        contents: 'new-payload',
        expectedPreviousSha256: sha256Bytes('old-payload'),
      },
      {
        root: managedRoot,
        relativePath: 'created.txt',
        contents: 'new-created',
      },
    ],
    metadataWrites: [
      {
        root: managedRoot,
        relativePath: 'metadata.json',
        contents: 'new-metadata',
        expectedPreviousSha256: sha256Bytes('old-metadata'),
      },
    ],
    manifestCommit: {
      root: managedRoot,
      relativePath: 'manifest.json',
      contents: 'new-manifest',
      expectedPreviousSha256: sha256Bytes('old-manifest'),
    },
    registryCommit: {
      root: managedRoot,
      relativePath: 'registry.json',
      contents: 'new-registry',
      expectedPreviousSha256: sha256Bytes('old-registry'),
    },
    ...(external ? { externalStep: external } : {}),
    hooks: {
      beforeMutation: async () => {
        if (point === 'before-first' && mutationCount === 0) await killNow();
      },
      afterMutation: async (mutation) => {
        mutationCount += 1;
        if (
          (point === 'after-delete' && mutation.kind === 'delete') ||
          (point === 'after-write' && mutation.kind === 'write') ||
          (point === 'after-created' &&
            mutation.relativePath === 'created.txt') ||
          (point === 'after-metadata' && mutation.kind === 'metadata') ||
          (point === 'after-registry' && mutation.kind === 'registry')
        ) {
          await killNow();
        }
      },
    },
  });
}

async function killNow(): Promise<never> {
  process.kill(process.pid, 'SIGKILL');
  return new Promise<never>(() => undefined);
}
