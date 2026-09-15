import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverAkExecutables } from '../../src/infrastructure/packages/executable-discovery.js';

describe('discoverAkExecutables', () => {
  it('recognizes a bounded npm-generated Windows ak.cmd shim', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ak-windows-shim-'));
    const packageRoot = path.join(root, 'node_modules', '@bestagentkits', 'ak');
    await mkdir(path.join(packageRoot, 'bin'), { recursive: true });
    await writeFile(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({
        name: '@bestagentkits/ak',
        version: '0.1.0-beta.0',
        bin: { ak: 'bin/ak.js' },
      }),
    );
    await writeFile(path.join(packageRoot, 'bin', 'ak.js'), '#!/usr/bin/env node\n');
    await writeFile(
      path.join(root, 'ak.cmd'),
      '@ECHO off\r\n"%dp0%\\node.exe" "%dp0%\\node_modules\\@bestagentkits\\ak\\bin\\ak.js" %*\r\n',
    );

    try {
      const candidates = await discoverAkExecutables(
        { PATH: root, PATHEXT: '.CMD' },
        'win32',
      );
      expect(candidates).toContainEqual(
        expect.objectContaining({
          kind: 'npm',
          packageVersion: '0.1.0-beta.0',
        }),
      );
    } finally {
      await rm(root, { recursive: true });
    }
  });

  it('does not trust a Windows shim without matching installed package metadata', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ak-windows-shim-unowned-'));
    await writeFile(
      path.join(root, 'ak.cmd'),
      '@ECHO off\r\nnode "%dp0%\\node_modules\\@bestagentkits\\ak\\bin\\ak.js" %*\r\n',
    );

    try {
      const candidates = await discoverAkExecutables(
        { PATH: root, PATHEXT: '.CMD' },
        'win32',
      );
      expect(candidates).toContainEqual(expect.objectContaining({ kind: 'unknown' }));
    } finally {
      await rm(root, { recursive: true });
    }
  });
});
