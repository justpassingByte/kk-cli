import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalFilesystemTransaction } from '../../src/infrastructure/filesystem/local-filesystem-transaction.js';

const roots: string[] = [];
const worker = path.resolve('tests/helpers/transaction-crash-worker.ts');

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('interrupted transaction recovery', () => {
  it(
    'recovers real process termination at every durable boundary',
    async () => {
      for (const point of [
        'before-first',
        'after-delete',
        'after-write',
        'after-metadata',
        'after-provider',
        'after-registry',
      ]) {
        const fixture = await createFixture();
        const crashed = await runWorker('crash', fixture, point);
        expectProcessKilled(crashed);

        const recovered = await runWorker('recover', fixture);
        expect(recovered.code, recovered.stderr).toBe(0);
        expect(JSON.parse(recovered.stdout)).toHaveLength(1);

        const committed = point === 'after-registry';
        await expectState(fixture.root, committed ? 'new' : 'old');
        if (point === 'after-provider') {
          const provider = JSON.parse(
            await fs.readFile(
              path.join(fixture.root, 'provider-state.json'),
              'utf8',
            ),
          ) as { pluginInstalled: boolean; marketplaceKnown: boolean };
          expect(provider).toMatchObject({
            pluginInstalled: false,
            marketplaceKnown: false,
          });
        }

        const repeated = await runWorker('recover', fixture);
        expect(repeated.code).toBe(0);
        expect(JSON.parse(repeated.stdout)).toEqual([]);
      }
    },
    60_000,
  );

  it(
    'preserves post-crash foreign edits and retains a pending journal',
    async () => {
      const fixture = await createFixture();
      await runWorker('crash', fixture, 'after-write');
      await fs.writeFile(path.join(fixture.root, 'payload.txt'), 'user-change');

      const recovery = await runWorker('recover', fixture);

      expect(recovery.code).not.toBe(0);
      expect(await fs.readFile(path.join(fixture.root, 'payload.txt'), 'utf8')).toBe(
        'user-change',
      );
      expect(await pendingJournalState(fixture.snapshots)).toBe('pending');
      expect((await fs.readdir(fixture.recovery)).length).toBeGreaterThan(0);
    },
    15_000,
  );

  it(
    'preserves a foreign edit introduced after rollback phase persistence',
    async () => {
      const fixture = await createFixture();
      expectProcessKilled(await runWorker('crash', fixture, 'after-write'));
      const transaction = new LocalFilesystemTransaction(undefined, {
        afterRollbackPhasePersisted: async () => {
          await fs.writeFile(
            path.join(fixture.root, 'payload.txt'),
            'late-user-change',
          );
        },
      });

      await expect(
        transaction.recover(fixture.snapshots, fixture.recovery),
      ).rejects.toBeDefined();

      expect(
        await fs.readFile(path.join(fixture.root, 'payload.txt'), 'utf8'),
      ).toBe('late-user-change');
      expect(await pendingJournalState(fixture.snapshots)).toBe('rolling_back');
      expect((await fs.readdir(fixture.recovery)).length).toBeGreaterThan(0);
    },
    15_000,
  );

  it(
    'preserves a foreign edit introduced after rollback temporary sync',
    async () => {
      const fixture = await createFixture();
      expectProcessKilled(await runWorker('crash', fixture, 'after-write'));
      const transaction = new LocalFilesystemTransaction(undefined, {
        afterRollbackTemporarySync: async (mutation) => {
          if (mutation.relativePath === 'payload.txt') {
            await fs.writeFile(
              path.join(fixture.root, 'payload.txt'),
              'late-user-change',
            );
          }
        },
      });

      await expect(
        transaction.recover(fixture.snapshots, fixture.recovery),
      ).rejects.toBeDefined();

      expect(
        await fs.readFile(path.join(fixture.root, 'payload.txt'), 'utf8'),
      ).toBe('late-user-change');
      expect(await pendingJournalState(fixture.snapshots)).toBe('rolling_back');
      expect((await fs.readdir(fixture.recovery)).length).toBeGreaterThan(0);
    },
    15_000,
  );

  it(
    'preserves a foreign replacement racing rollback of a created file',
    async () => {
      const fixture = await createFixture();
      expectProcessKilled(await runWorker('crash', fixture, 'after-created'));
      const transaction = new LocalFilesystemTransaction(undefined, {
        afterRollbackDisplace: async (mutation) => {
          if (mutation.relativePath === 'created.txt') {
            await fs.writeFile(
              path.join(fixture.root, 'created.txt'),
              'foreign-created',
            );
          }
        },
      });

      await expect(
        transaction.recover(fixture.snapshots, fixture.recovery),
      ).rejects.toBeDefined();

      expect(
        await fs.readFile(path.join(fixture.root, 'created.txt'), 'utf8'),
      ).toBe('foreign-created');
      expect(await pendingJournalState(fixture.snapshots)).toBe('rolling_back');
      expect((await fs.readdir(fixture.recovery)).length).toBeGreaterThan(0);
    },
    15_000,
  );

  it(
    'recovers the Windows displaced-target crash window from exact artifacts',
    async () => {
      const fixture = await createFixture();
      await runWorker('crash', fixture, 'before-first');
      const { directory, journal } = await readJournal(fixture.snapshots);
      const outcome = journal.outcomes.find(
        (candidate) => candidate.relativePath === 'payload.txt',
      );
      if (!outcome?.temporaryRelativePath || !outcome.displacedRelativePath) {
        throw new Error('Payload artifact paths are missing from the journal.');
      }
      await fs.rename(
        path.join(fixture.root, 'payload.txt'),
        path.join(fixture.root, outcome.displacedRelativePath),
      );
      await fs.writeFile(
        path.join(fixture.root, outcome.temporaryRelativePath),
        'new-payload',
      );

      const recovered = await runWorker('recover', fixture);

      expect(recovered.code).toBe(0);
      expect(await fs.readFile(path.join(fixture.root, 'payload.txt'), 'utf8')).toBe(
        'old-payload',
      );
      await expect(
        fs.stat(path.join(fixture.root, outcome.temporaryRelativePath)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(
        fs.stat(path.join(fixture.root, outcome.displacedRelativePath)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(directory).toContain('transaction-');
    },
    15_000,
  );

  it(
    'serializes concurrent fresh-process recovery',
    async () => {
      const fixture = await createFixture();
      await runWorker('crash', fixture, 'after-write');

      const results = await Promise.all([
        runWorker('recover', fixture),
        runWorker('recover', fixture),
      ]);

      expect(results.every((result) => result.code === 0)).toBe(true);
      expect(
        results.map((result) => JSON.parse(result.stdout).length).sort(),
      ).toEqual([0, 1]);
      await expectState(fixture.root, 'old');
    },
    15_000,
  );

  it(
    'keeps recovery pending when provider restoration fails and retries idempotently',
    async () => {
      const fixture = await createFixture();
      await runWorker('crash', fixture, 'after-provider');

      const failed = await runWorker('recover', fixture, 'provider-fail');
      expect(failed.code).not.toBe(0);
      expect(await pendingJournalState(fixture.snapshots)).toBe('rolling_back');
      const receiptFiles = await fs.readdir(fixture.recovery);
      const receipt = JSON.parse(
        await fs.readFile(
          path.join(fixture.recovery, receiptFiles.at(-1) as string),
          'utf8',
        ),
      ) as {
        externalFailures: Array<{
          code?: string;
          remediation?: string;
        }>;
      };
      expect(receipt.externalFailures).toEqual([
        expect.objectContaining({
          code: 'conflict',
          remediation: 'Review provider state before retrying recovery.',
        }),
      ]);

      const retried = await runWorker('recover', fixture);
      expect(retried.code).toBe(0);
      await expectState(fixture.root, 'old');
      const provider = JSON.parse(
        await fs.readFile(
          path.join(fixture.root, 'provider-state.json'),
          'utf8',
        ),
      ) as { pluginInstalled: boolean };
      expect(provider.pluginInstalled).toBe(false);
    },
    20_000,
  );

  it(
    'recovers when the rollback process is killed at restartable boundaries',
    async () => {
      for (const point of [
        'recovery-after-phase',
        'recovery-after-temp-sync',
        'recovery-after-restore',
      ]) {
        const fixture = await createFixture();
        expectProcessKilled(await runWorker('crash', fixture, 'after-write'));

        const interrupted = await runWorker('recover', fixture, point);
        expectProcessKilled(interrupted);

        const recovered = await runWorker('recover', fixture);
        expect(recovered.code).toBe(0);
        await expectState(fixture.root, 'old');
        await expectNoTransactionArtifacts(fixture.root);
        expect(await pendingJournalState(fixture.snapshots)).toBe('rolled_back');

        const repeated = await runWorker('recover', fixture);
        expect(repeated.code).toBe(0);
        expect(JSON.parse(repeated.stdout)).toEqual([]);
      }
    },
    30_000,
  );

  it(
    'resumes the Windows rollback displacement state without deleting its preimage',
    async () => {
      const fixture = await createFixture();
      expectProcessKilled(await runWorker('crash', fixture, 'after-write'));
      expectProcessKilled(
        await runWorker('recover', fixture, 'recovery-after-temp-sync'),
      );
      const { journal } = await readJournal(fixture.snapshots);
      const outcome = journal.outcomes.find(
        (candidate) => candidate.relativePath === 'payload.txt',
      );
      if (
        !outcome?.rollbackTemporaryRelativePath ||
        !outcome.rollbackDisplacedRelativePath
      ) {
        throw new Error('Rollback artifact paths are missing from the journal.');
      }
      await fs.rename(
        path.join(fixture.root, 'payload.txt'),
        path.join(fixture.root, outcome.rollbackDisplacedRelativePath),
      );

      const recovered = await runWorker('recover', fixture);

      expect(recovered.code).toBe(0);
      await expectState(fixture.root, 'old');
      await expectNoTransactionArtifacts(fixture.root);
      expect(await pendingJournalState(fixture.snapshots)).toBe('rolled_back');
    },
    20_000,
  );

  it.skipIf(process.platform !== 'win32')(
    'recovers after a real Windows rollback displacement kill',
    async () => {
      const fixture = await createFixture();
      expectProcessKilled(await runWorker('crash', fixture, 'after-write'));

      expectProcessKilled(
        await runWorker('recover', fixture, 'recovery-after-displace'),
      );
      expect((await runWorker('recover', fixture)).code).toBe(0);
      await expectState(fixture.root, 'old');
      await expectNoTransactionArtifacts(fixture.root);
    },
    20_000,
  );

  it(
    'recovers after a kill during artifact cleanup and provider compensation',
    async () => {
      const cleanupFixture = await createFixture();
      expectProcessKilled(
        await runWorker('crash', cleanupFixture, 'after-write'),
      );
      const { journal } = await readJournal(cleanupFixture.snapshots);
      const payload = journal.outcomes.find(
        (candidate) => candidate.relativePath === 'payload.txt',
      );
      if (!payload?.temporaryRelativePath) {
        throw new Error('Forward temporary path is missing from the journal.');
      }
      await fs.writeFile(
        path.join(cleanupFixture.root, payload.temporaryRelativePath),
        'new-payload',
      );
      expectProcessKilled(
        await runWorker('recover', cleanupFixture, 'recovery-mid-cleanup'),
      );
      expect((await runWorker('recover', cleanupFixture)).code).toBe(0);
      await expectState(cleanupFixture.root, 'old');
      await expectNoTransactionArtifacts(cleanupFixture.root);

      const providerFixture = await createFixture();
      expectProcessKilled(
        await runWorker('crash', providerFixture, 'after-provider'),
      );
      expectProcessKilled(
        await runWorker('recover', providerFixture, 'provider-crash'),
      );
      expect((await runWorker('recover', providerFixture)).code).toBe(0);
      await expectState(providerFixture.root, 'old');
      await expectNoTransactionArtifacts(providerFixture.root);
    },
    25_000,
  );

  it(
    'blocks tampered journal and snapshot metadata without changing managed files',
    async () => {
      for (const target of ['journal', 'snapshot'] as const) {
        const fixture = await createFixture();
        await runWorker('crash', fixture, 'after-write');
        const { directory, journal } = await readJournal(fixture.snapshots);
        const file =
          target === 'journal'
            ? path.join(fixture.snapshots, directory, 'journal.json')
            : path.join(fixture.snapshots, directory, 'snapshot.json');
        const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as Record<
          string,
          unknown
        >;
        parsed.createdAt = 'tampered';
        await fs.writeFile(file, `${JSON.stringify(parsed, null, 2)}\n`);

        const recovery = await runWorker('recover', fixture);
        expect(recovery.code).not.toBe(0);
        expect(
          await fs.readFile(path.join(fixture.root, 'payload.txt'), 'utf8'),
        ).toBe('new-payload');
        expect(journal.state).toBe('pending');
      }
    },
    20_000,
  );

  it.skipIf(process.platform === 'win32')(
    'blocks a post-crash symlink without touching its target',
    async () => {
      const fixture = await createFixture();
      await runWorker('crash', fixture, 'after-write');
      const outside = path.join(path.dirname(fixture.root), 'outside.txt');
      await fs.writeFile(outside, 'outside');
      await fs.rm(path.join(fixture.root, 'payload.txt'));
      await fs.symlink(outside, path.join(fixture.root, 'payload.txt'));

      const recovery = await runWorker('recover', fixture);

      expect(recovery.code).not.toBe(0);
      expect(await fs.readFile(outside, 'utf8')).toBe('outside');
      expect((await fs.lstat(path.join(fixture.root, 'payload.txt'))).isSymbolicLink()).toBe(
        true,
      );
    },
    15_000,
  );
});

async function createFixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'kk-crash-recovery-'));
  roots.push(base);
  const root = path.join(base, 'root');
  const snapshots = path.join(base, 'snapshots');
  const recovery = path.join(base, 'recovery');
  await fs.mkdir(root);
  await Promise.all([
    fs.writeFile(path.join(root, 'payload.txt'), 'old-payload'),
    fs.writeFile(path.join(root, 'delete.txt'), 'old-delete'),
    fs.writeFile(path.join(root, 'metadata.json'), 'old-metadata'),
    fs.writeFile(path.join(root, 'manifest.json'), 'old-manifest'),
    fs.writeFile(path.join(root, 'registry.json'), 'old-registry'),
  ]);
  return {
    root: await fs.realpath(root),
    snapshots,
    recovery,
  };
}

async function expectState(root: string, state: 'old' | 'new'): Promise<void> {
  expect(await fs.readFile(path.join(root, 'payload.txt'), 'utf8')).toBe(
    `${state}-payload`,
  );
  expect(await fs.readFile(path.join(root, 'metadata.json'), 'utf8')).toBe(
    `${state}-metadata`,
  );
  expect(await fs.readFile(path.join(root, 'manifest.json'), 'utf8')).toBe(
    `${state}-manifest`,
  );
  expect(await fs.readFile(path.join(root, 'registry.json'), 'utf8')).toBe(
    `${state}-registry`,
  );
  if (state === 'old') {
    expect(await fs.readFile(path.join(root, 'delete.txt'), 'utf8')).toBe(
      'old-delete',
    );
    await expect(fs.stat(path.join(root, 'created.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } else {
    await expect(fs.stat(path.join(root, 'delete.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await fs.readFile(path.join(root, 'created.txt'), 'utf8')).toBe(
      'new-created',
    );
  }
}

async function runWorker(
  mode: 'crash' | 'recover',
  fixture: Awaited<ReturnType<typeof createFixture>>,
  point = '',
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        worker,
        mode,
        fixture.root,
        fixture.snapshots,
        fixture.recovery,
        point,
      ],
      {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code, signal) => {
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8').trim(),
        stderr: Buffer.concat(stderr).toString('utf8').trim(),
      });
    });
  });
}

async function pendingJournalState(snapshots: string): Promise<string> {
  const { directory, journal } = await readJournal(snapshots);
  const root = path.join(snapshots, directory);
  for (const [file, state] of [
    ['journal.rolled-back', 'rolled_back'],
    ['journal.committed', 'committed'],
    ['journal.rolling-back', 'rolling_back'],
  ] as const) {
    if (await fs.stat(path.join(root, file)).then(() => true).catch(() => false)) {
      return state;
    }
  }
  return journal.state;
}

async function readJournal(snapshots: string): Promise<{
  directory: string;
  journal: {
    state: string;
    outcomes: Array<{
      relativePath: string;
      temporaryRelativePath?: string;
      displacedRelativePath?: string;
      rollbackTemporaryRelativePath?: string;
      rollbackDisplacedRelativePath?: string;
    }>;
  };
}> {
  const [directory] = (await fs.readdir(snapshots)).filter((entry) =>
    entry.startsWith('transaction-'),
  );
  if (!directory) throw new Error('Transaction snapshot directory is missing.');
  const journal = JSON.parse(
    await fs.readFile(path.join(snapshots, directory, 'journal.json'), 'utf8'),
  ) as {
    state: string;
    outcomes: Array<{
      relativePath: string;
      temporaryRelativePath?: string;
      displacedRelativePath?: string;
      rollbackTemporaryRelativePath?: string;
      rollbackDisplacedRelativePath?: string;
    }>;
  };
  return { directory, journal };
}

function expectProcessKilled(result: {
  code: number | null;
  signal: NodeJS.Signals | null;
}): void {
  if (process.platform === 'win32') {
    expect(result.code).not.toBe(0);
  } else {
    expect(result.signal).toBe('SIGKILL');
  }
}

async function expectNoTransactionArtifacts(root: string): Promise<void> {
  const entries = await fs.readdir(root, { recursive: true });
  expect(entries.filter((entry) => path.basename(entry).includes('.kk-'))).toEqual(
    [],
  );
}
