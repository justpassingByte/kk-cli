import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { INSTALL_MANIFEST_VERSION } from '../../src/domain/kits/install-manifest.js';
import { INSTALLED_KIT_REGISTRY_VERSION } from '../../src/domain/kits/installed-kit-registry.js';
import { sha256Bytes } from '../../src/infrastructure/filesystem/file-hash.js';
import {
  assertPortableRelativePath,
  canonicalizeRoot,
  isPathWithinRoot,
} from '../../src/infrastructure/filesystem/path-guard.js';
import {
  InstalledKitStore,
  createInstallManifest,
  readInstallManifest,
  serializeInstallManifest,
} from '../../src/infrastructure/installed-kits/installed-kit-store.js';
import { classifyInstalledPath } from '../../src/infrastructure/installed-kits/ownership-classifier.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kk-installed-kit-test-'));
  temporaryDirectories.push(root);
  return fs.realpath(root);
}

describe('InstalledKitStore', () => {
  it('round-trips a versioned registry atomically', async () => {
    const root = await temporaryRoot();
    const installRoot = path.join(root, 'kit');
    await fs.mkdir(installRoot);
    const manifestPath = path.join(installRoot, '.kk', 'install-manifest.json');
    const store = new InstalledKitStore(path.join(root, 'installed-kits.json'));
    const now = '2026-07-28T00:00:00.000Z';
    const registry = store.prepareUpsert(
      {
        installationId: 'engineer:user',
        kit: 'engineer',
        kitVersion: '2.0.0',
        runtime: 'claude-code',
        scope: 'global',
        channel: 'stable',
        installRoot,
        manifestPath,
        files: [{ rel_path: 'skills/one.md', sha256: sha256Bytes('one') }],
        installedAt: now,
        updatedAt: now,
      },
      { version: INSTALLED_KIT_REGISTRY_VERSION, kits: {} },
    );

    await store.save(registry);

    expect(await store.load()).toEqual(registry);
    expect(JSON.parse(await fs.readFile(path.join(root, 'installed-kits.json'), 'utf8'))).toMatchObject({
      version: 1,
      kits: { 'engineer:user': { kit: 'engineer' } },
    });
  });

  it('uses legacy-compatible per-install manifest field names', async () => {
    const root = await temporaryRoot();
    const manifestPath = path.join(root, 'install-manifest.json');
    const manifest = createInstallManifest({
      kit: 'engineer',
      kitVersion: '2.0.0',
      files: [{ rel_path: 'skills/one.md', sha256: sha256Bytes('one') }],
      skillSelection: { mode: 'selected', skills: ['one'], selected_count: 1, total_count: 2 },
    });
    await fs.writeFile(manifestPath, serializeInstallManifest(manifest));

    const raw = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    expect(raw).toEqual({
      version: INSTALL_MANIFEST_VERSION,
      kit: 'engineer',
      kit_version: '2.0.0',
      files: [{ rel_path: 'skills/one.md', sha256: sha256Bytes('one') }],
      skill_selection: { mode: 'selected', skills: ['one'], selected_count: 1, total_count: 2 },
    });
    expect(await readInstallManifest(manifestPath)).toEqual(manifest);
  });

  it('classifies ownership without adopting changed or foreign files', async () => {
    const root = await temporaryRoot();
    await fs.writeFile(path.join(root, 'clean.txt'), 'clean');
    await fs.writeFile(path.join(root, 'changed.txt'), 'changed');
    await fs.writeFile(path.join(root, 'foreign.txt'), 'foreign');

    await expect(classifyInstalledPath(root, 'clean.txt', sha256Bytes('clean'))).resolves.toMatchObject({
      status: 'owned-clean',
    });
    await expect(classifyInstalledPath(root, 'changed.txt', sha256Bytes('old'))).resolves.toMatchObject({
      status: 'owned-modified',
    });
    await expect(classifyInstalledPath(root, 'foreign.txt')).resolves.toMatchObject({ status: 'foreign' });
    await expect(classifyInstalledPath(root, 'missing.txt', sha256Bytes('old'))).resolves.toMatchObject({
      status: 'missing',
    });
  });

  it('applies portable path and root-boundary rules', () => {
    expect(() => assertPortableRelativePath('skills/engineer/SKILL.md')).not.toThrow();
    for (const unsafe of ['../outside', 'skills/../../outside', '/absolute', 'C:\\outside', 'a\\b', 'CON']) {
      expect(() => assertPortableRelativePath(unsafe)).toThrow();
    }
    expect(isPathWithinRoot('/kits/one', '/kits/one/file', 'linux')).toBe(true);
    expect(isPathWithinRoot('/kits/one', '/kits/one-other/file', 'linux')).toBe(false);
    expect(isPathWithinRoot('C:\\Kits\\One', 'c:\\kits\\one\\file', 'win32')).toBe(true);
    expect(isPathWithinRoot('C:\\Kits\\One', 'C:\\Kits\\Two\\file', 'win32')).toBe(false);
  });

  it('refuses a filesystem root as a mutation root', async () => {
    await expect(canonicalizeRoot(path.parse(process.cwd()).root)).rejects.toMatchObject({
      code: 'security_error',
    });
  });

  it.skipIf(process.platform === 'win32')('refuses symlinked ownership metadata and payload paths', async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await fs.writeFile(path.join(outside, 'manifest.json'), '{}');
    await fs.symlink(path.join(outside, 'manifest.json'), path.join(root, 'install-manifest.json'));
    await expect(readInstallManifest(path.join(root, 'install-manifest.json'))).rejects.toMatchObject({
      code: 'security_error',
    });

    await fs.symlink(outside, path.join(root, 'linked'));
    await expect(classifyInstalledPath(root, 'linked/file.txt')).rejects.toMatchObject({
      code: 'security_error',
    });
  });
});
