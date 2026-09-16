import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { NpmRuntimeManager } from '../../src/infrastructure/packages/npm-runtime-manager.js';

describe('NpmRuntimeManager', () => {
  it('updates through npm and proves the freshly installed package entrypoint', async () => {
    const prefix = await mkdtemp(path.join(os.tmpdir(), 'kk-npm-prefix-'));
    const packageRoot =
      process.platform === 'win32'
        ? path.join(prefix, 'node_modules', 'kk-cli')
        : path.join(prefix, 'lib', 'node_modules', 'kk-cli');
    const packagePath = path.join(packageRoot, 'package.json');
    const entrypoint = path.join(packageRoot, 'bin', 'kk.js');
    await mkdir(path.dirname(entrypoint), { recursive: true });
    await writePackage(packagePath, '0.1.0-beta.0');
    await writeFile(entrypoint, '#!/usr/bin/env node\n');

    const execute = vi.fn(async (_executable: string, args: string[]) => {
      if (args[0] === 'prefix') return { stdout: `${prefix}\n` };
      if (args[0] === 'view') return { stdout: '"0.1.0-beta.1"\n' };
      if (args[0] === 'install') {
        await writePackage(packagePath, '0.1.0-beta.1');
        return { stdout: 'updated\n' };
      }
      throw new Error('unexpected command');
    });
    const manager = new NpmRuntimeManager('npm', execute, packageRoot);

    try {
      const installed = await manager.update('beta');
      expect(installed).toMatchObject({
        packageRoot,
        entrypoint,
        version: '0.1.0-beta.1',
      });
      expect(execute).toHaveBeenCalledWith('npm', [
        'install',
        '--global',
        'kk-cli@beta',
        '--no-audit',
        '--no-fund',
      ]);
      expect(execute).toHaveBeenCalledWith('npm', [
        'view',
        'kk-cli@beta',
        'version',
        '--json',
      ]);
    } finally {
      await rm(prefix, { recursive: true });
    }
  });

  it('fails closed when the running package is not npm global owner', async () => {
    const prefix = await mkdtemp(path.join(os.tmpdir(), 'kk-npm-owner-'));
    const packageRoot =
      process.platform === 'win32'
        ? path.join(prefix, 'node_modules', 'kk-cli')
        : path.join(prefix, 'lib', 'node_modules', 'kk-cli');
    await mkdir(path.join(packageRoot, 'bin'), { recursive: true });
    await writePackage(path.join(packageRoot, 'package.json'), '0.1.0-beta.0');
    await writeFile(path.join(packageRoot, 'bin', 'kk.js'), '#!/usr/bin/env node\n');
    const manager = new NpmRuntimeManager(
      'npm',
      async () => ({ stdout: `${prefix}\n` }),
      path.join(prefix, 'different-package'),
    );

    try {
      await expect(manager.update('beta')).rejects.toMatchObject({ code: 'conflict' });
    } finally {
      await rm(prefix, { recursive: true });
    }
  });
});

async function writePackage(packagePath: string, version: string): Promise<void> {
  await writeFile(
    packagePath,
    JSON.stringify({
      name: 'kk-cli',
      version,
      bin: { kk: 'bin/kk.js' },
    }),
  );
}
