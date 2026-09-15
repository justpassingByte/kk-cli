import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UninstallUseCase } from '../../src/application/uninstall-use-case.js';
import type { InstalledKitRecord } from '../../src/domain/kits/installed-kit-registry.js';
import { LocalFilesystemTransaction } from '../../src/infrastructure/filesystem/local-filesystem-transaction.js';
import { sha256Bytes } from '../../src/infrastructure/filesystem/file-hash.js';
import {
  InstalledKitStore,
  createInstallManifest,
  serializeInstallManifest,
} from '../../src/infrastructure/installed-kits/installed-kit-store.js';
import type { AgentKitPaths } from '../../src/infrastructure/paths/agentkit-paths.js';
import type { PromptService } from '../../src/presentation/prompt-service.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), 'ak-uninstall-test-'));
  temporaryDirectories.push(created);
  const home = await fs.realpath(created);
  const paths: AgentKitPaths = {
    home,
    credentials: path.join(home, 'credentials.json'),
    installedKits: path.join(home, 'installed-kits.json'),
    locks: path.join(home, 'locks'),
    snapshots: path.join(home, 'snapshots'),
    recovery: path.join(home, 'recovery'),
    supportReports: path.join(home, 'support-reports'),
  };
  const store = new InstalledKitStore(paths.installedKits);
  return { home, paths, store };
}

function prompts(confirm = true): PromptService {
  return {
    chooseAuthMethod: vi.fn(),
    email: vi.fn(),
    otp: vi.fn(),
    apiKey: vi.fn(),
    confirm: vi.fn(async () => confirm),
  };
}

async function seed(
  state: Awaited<ReturnType<typeof fixture>>,
  runtime: InstalledKitRecord['runtime'] = 'codex',
): Promise<InstalledKitRecord> {
  const kit = 'engineer';
  const installRoot = path.join(state.home, 'adapters', runtime, kit);
  const manifestPath = path.join(installRoot, '.agentkit', 'install-manifest.json');
  const files = [
    { rel_path: 'clean.txt', sha256: sha256Bytes('clean') },
    { rel_path: 'modified.txt', sha256: sha256Bytes('original') },
    { rel_path: 'foreign', sha256: sha256Bytes('was-a-file') },
    { rel_path: 'missing.txt', sha256: sha256Bytes('missing') },
  ];
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(path.join(installRoot, 'clean.txt'), 'clean');
  await fs.writeFile(path.join(installRoot, 'modified.txt'), 'user edit');
  await fs.mkdir(path.join(installRoot, 'foreign'));
  const manifest = createInstallManifest({ kit, kitVersion: '2.0.0', files });
  await fs.writeFile(manifestPath, serializeInstallManifest(manifest));
  const now = '2026-07-28T00:00:00.000Z';
  const record: InstalledKitRecord = {
    installationId: `global:${runtime}:${kit}`,
    kit,
    kitVersion: '2.0.0',
    runtime,
    scope: 'global',
    channel: 'stable',
    installRoot,
    manifestPath,
    files,
    installedAt: now,
    updatedAt: now,
  };
  const current = await state.store.load();
  await state.store.save(state.store.prepareUpsert(record, current));
  return record;
}

describe('UninstallUseCase', () => {
  it('deletes only clean owned files, preserves residue, and commits the registry last', async () => {
    const state = await fixture();
    const record = await seed(state);
    await fs.appendFile(record.manifestPath, ' ');
    const useCase = new UninstallUseCase(
      state.paths,
      state.store,
      new LocalFilesystemTransaction(),
      prompts(),
    );

    const result = await useCase.execute({
      installationId: record.installationId,
      yes: true,
      noInteractive: true,
    });

    await expect(fs.stat(path.join(record.installRoot, 'clean.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(path.join(record.installRoot, 'modified.txt'), 'utf8')).toBe('user edit');
    await expect(fs.stat(path.join(record.installRoot, 'foreign'))).resolves.toMatchObject({});
    await expect(fs.stat(record.manifestPath)).resolves.toMatchObject({});
    expect((await state.store.load()).kits).toEqual({});
    expect(result.data).toMatchObject({
      installation_id: record.installationId,
      deleted_files: ['clean.txt'],
      preserved_files: ['foreign', 'missing.txt', 'modified.txt'],
      manifest_deleted: false,
      registry_removed: true,
      npm_runtime_removed: false,
      preview: {
        owned_clean: ['clean.txt'],
        owned_modified: ['modified.txt'],
        foreign: ['foreign'],
        missing: ['missing.txt'],
        manifest_status: 'owned-modified',
      },
      outcome: {
        owned_clean: ['clean.txt'],
        owned_modified: ['modified.txt'],
        foreign: ['foreign'],
        missing: ['missing.txt'],
      },
    });
  });

  it('removes a verified manifest and prunes only empty lifecycle directories', async () => {
    const state = await fixture();
    const record = await seed(state, 'cursor');
    await fs.rm(path.join(record.installRoot, 'modified.txt'));
    await fs.rm(path.join(record.installRoot, 'foreign'), { recursive: true });
    record.files = [{ rel_path: 'clean.txt', sha256: sha256Bytes('clean') }];
    await fs.writeFile(
      record.manifestPath,
      serializeInstallManifest(createInstallManifest({
        kit: record.kit,
        ...(record.kitVersion ? { kitVersion: record.kitVersion } : {}),
        files: record.files,
      })),
    );
    await state.store.save(state.store.prepareUpsert(record, await state.store.load()));

    const result = await new UninstallUseCase(
      state.paths,
      state.store,
      new LocalFilesystemTransaction(),
      prompts(),
    ).execute({
      kitId: 'engineer',
      runtime: 'cursor',
      scope: 'global',
      yes: true,
      noInteractive: true,
    });

    await expect(fs.stat(record.installRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(result.data).toMatchObject({
      deleted_files: ['clean.txt'],
      manifest_deleted: true,
      registry_removed: true,
    });
    expect((result.data['cleanup_removed_directories'] as string[]).length).toBeGreaterThan(0);
  });

  it('previews and cancels without mutating when confirmation is declined', async () => {
    const state = await fixture();
    const record = await seed(state);
    const prompt = prompts(false);
    const useCase = new UninstallUseCase(
      state.paths,
      state.store,
      new LocalFilesystemTransaction(),
      prompt,
      () => true,
    );

    await expect(
      useCase.execute({
        installationId: record.installationId,
        yes: false,
        noInteractive: false,
      }),
    ).rejects.toMatchObject({
      code: 'cancelled',
      details: { preview: { owned_clean: ['clean.txt'] } },
    });
    expect(prompt.confirm).toHaveBeenCalledWith(expect.stringContaining('1 owned file(s) will be deleted'), false);
    expect((await state.store.load()).kits[record.installationId]).toBeDefined();
    await expect(fs.stat(path.join(record.installRoot, 'clean.txt'))).resolves.toMatchObject({});
  });

  it('reports the locked classification when a clean file changes during confirmation', async () => {
    const state = await fixture();
    const record = await seed(state);
    const prompt = prompts(true);
    vi.mocked(prompt.confirm).mockImplementation(async () => {
      await fs.writeFile(path.join(record.installRoot, 'clean.txt'), 'changed during confirmation');
      return true;
    });
    const result = await new UninstallUseCase(
      state.paths,
      state.store,
      new LocalFilesystemTransaction(),
      prompt,
      () => true,
    ).execute({
      installationId: record.installationId,
      yes: false,
      noInteractive: false,
    });

    expect(result.data).toMatchObject({
      preview: { owned_clean: ['clean.txt'] },
      outcome: { owned_modified: ['clean.txt', 'modified.txt'] },
      deleted_files: [],
    });
    expect(await fs.readFile(path.join(record.installRoot, 'clean.txt'), 'utf8')).toBe('changed during confirmation');
  });

  it('rejects an ambiguous selector with deterministic installation IDs', async () => {
    const state = await fixture();
    await seed(state, 'codex');
    await seed(state, 'cursor');
    const useCase = new UninstallUseCase(
      state.paths,
      state.store,
      new LocalFilesystemTransaction(),
      prompts(),
    );

    await expect(
      useCase.execute({ kitId: 'engineer', yes: true, noInteractive: true }),
    ).rejects.toMatchObject({
      code: 'conflict',
      details: {
        installation_ids: ['global:codex:engineer', 'global:cursor:engineer'],
      },
    });
  });
});
