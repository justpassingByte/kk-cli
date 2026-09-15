import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractVerifiedKitArtifact } from '../../src/infrastructure/registry/safe-tar-extractor.js';
import { downloadVerifiedArtifact } from '../../src/infrastructure/registry/verified-artifact-downloader.js';
import { createManifest } from '../fixtures/registry/manifest-fixture.js';
import { createTarGzip } from '../fixtures/registry/tar-fixture.js';

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((target) => fs.promises.rm(target, { recursive: true, force: true })));
});

describe('verified artifact pipeline', () => {
  it('downloads exact signed bytes and safely extracts the required kit root', async () => {
    const archive = await createTarGzip([
      { name: 'engineer/', type: 'directory', mode: 0o755 },
      { name: 'engineer/kit.yaml', body: 'name: engineer\n' },
      { name: 'engineer/skills/example/SKILL.md', body: '# Example\n' },
    ]);
    const manifest = createManifest({
      artifact: {
        ...createManifest().artifact,
        size: archive.length,
        sha256: crypto.createHash('sha256').update(archive).digest('hex'),
      },
    });
    const downloaded = await downloadVerifiedArtifact(manifest, {
      now: new Date('2026-07-28T06:05:00Z'),
      request: async () =>
        new Response(new Uint8Array(archive), {
          headers: { 'content-length': String(archive.length) },
        }),
    });
    const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ak-registry-test-'));
    cleanupPaths.push(parent);
    const destination = path.join(parent, 'package');

    await extractVerifiedKitArtifact(downloaded, destination, 'engineer');

    await expect(
      fs.promises.readFile(path.join(destination, 'engineer', 'kit.yaml'), 'utf8'),
    ).resolves.toBe('name: engineer\n');
  });

  it('rejects size and digest mismatches', async () => {
    const bytes = Buffer.from('artifact');
    const manifest = createManifest({
      artifact: {
        ...createManifest().artifact,
        size: bytes.length,
        sha256: '0'.repeat(64),
      },
    });
    await expect(
      downloadVerifiedArtifact(manifest, {
        now: new Date('2026-07-28T06:05:00Z'),
        request: async () => new Response(new Uint8Array(bytes)),
      }),
    ).rejects.toThrow(/SHA-256/i);

    await expect(
      downloadVerifiedArtifact(
        createManifest({
          artifact: {
            ...manifest.artifact,
            size: bytes.length + 1,
          },
        }),
        {
          now: new Date('2026-07-28T06:05:00Z'),
          request: async () => new Response(new Uint8Array(bytes)),
        },
      ),
    ).rejects.toThrow(/size/i);
  });

  it.each([
    {
      name: 'path traversal',
      entries: [{ name: '../escape', body: 'bad' }],
      expected: /escapes/i,
    },
    {
      name: 'absolute path',
      entries: [{ name: '/absolute', body: 'bad' }],
      expected: /escapes/i,
    },
    {
      name: 'symlink',
      entries: [{ name: 'engineer/link', type: 'symlink' as const, linkname: '../outside' }],
      expected: /unsupported type/i,
    },
    {
      name: 'hardlink',
      entries: [{ name: 'engineer/link', type: 'link' as const, linkname: 'engineer/kit.yaml' }],
      expected: /unsupported type/i,
    },
  ])('rejects $name entries', async ({ entries, expected }) => {
    const archive = await createTarGzip(entries);
    const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ak-registry-test-'));
    cleanupPaths.push(parent);
    await expect(
      extractVerifiedKitArtifact(archive, path.join(parent, 'package'), 'engineer'),
    ).rejects.toThrow(expected);
  });

  it('rejects archives without <kitId>/kit.yaml', async () => {
    const archive = await createTarGzip([
      { name: 'engineer/README.md', body: 'missing manifest\n' },
    ]);
    const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ak-registry-test-'));
    cleanupPaths.push(parent);
    await expect(
      extractVerifiedKitArtifact(archive, path.join(parent, 'package'), 'engineer'),
    ).rejects.toThrow(/missing engineer\/kit.yaml/i);
  });

  it('rejects archives containing any entry outside the exact kit root', async () => {
    const archive = await createTarGzip([
      { name: 'engineer/kit.yaml', body: 'name: engineer\n' },
      { name: 'other/README.md', body: 'unexpected root\n' },
    ]);
    const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ak-registry-test-'));
    cleanupPaths.push(parent);

    await expect(
      extractVerifiedKitArtifact(archive, path.join(parent, 'package'), 'engineer'),
    ).rejects.toThrow(/outside the required "engineer\/" root/i);
  });
});
