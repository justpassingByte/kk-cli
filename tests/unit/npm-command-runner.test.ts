import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveNpmInvocation } from '../../src/infrastructure/packages/npm-command-runner.js';

describe('npm command runner', () => {
  it('runs npm-cli.js with the active Node executable on Windows', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ak-npm-runner-'));
    const nodeExecutable = path.join(root, 'node.exe');
    const npmCli = path.join(
      root,
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js',
    );
    await mkdir(path.dirname(npmCli), { recursive: true });
    await Promise.all([
      writeFile(nodeExecutable, ''),
      writeFile(npmCli, 'process.exitCode = 0;\n'),
    ]);

    try {
      await expect(
        resolveNpmInvocation('win32', nodeExecutable),
      ).resolves.toEqual({
        executable: nodeExecutable,
        argsPrefix: [npmCli],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses the npm executable directly outside Windows', async () => {
    await expect(resolveNpmInvocation('linux', '/usr/bin/node')).resolves.toEqual({
      executable: 'npm',
      argsPrefix: [],
    });
  });
});
