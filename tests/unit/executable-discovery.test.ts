import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverKkExecutables } from '../../src/infrastructure/packages/executable-discovery.js';

describe('discoverKkExecutables', () => {
  it('recognizes a bounded npm-generated Windows kk.cmd shim', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kk-windows-shim-'));
    const packageRoot = path.join(root, 'node_modules', 'kk-cli');
    await mkdir(path.join(packageRoot, 'bin'), { recursive: true });
    await writeFile(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({
        name: 'kk-cli',
        version: '0.1.0-beta.0',
        bin: { kk: 'bin/kk.js' },
      }),
    );
    await writeFile(path.join(packageRoot, 'bin', 'kk.js'), '#!/usr/bin/env node\n');
    await writeFile(
      path.join(root, 'kk.cmd'),
      '@ECHO off\r\n"%dp0%\\node.exe" "%dp0%\\node_modules\\kk-cli\\bin\\kk.js" %*\r\n',
    );

    try {
      const candidates = await discoverKkExecutables(
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
    const root = await mkdtemp(path.join(os.tmpdir(), 'kk-windows-shim-unowned-'));
    await writeFile(
      path.join(root, 'kk.cmd'),
      '@ECHO off\r\nnode "%dp0%\\node_modules\\kk-cli\\bin\\kk.js" %*\r\n',
    );

    try {
      const candidates = await discoverKkExecutables(
        { PATH: root, PATHEXT: '.CMD' },
        'win32',
      );
      expect(candidates).toContainEqual(expect.objectContaining({ kind: 'unknown' }));
    } finally {
      await rm(root, { recursive: true });
    }
  });
});
