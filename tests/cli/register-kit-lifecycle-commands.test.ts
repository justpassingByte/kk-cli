import { cac } from 'cac';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerKitLifecycleCommands } from '../../src/cli/register-kit-lifecycle-commands.js';

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

function cliFixture() {
  const cli = cac('ak');
  cli
    .option('-y, --yes', 'Confirm the proposed operation')
    .option('--no-interactive', 'Never prompt for input')
    .option('--json', 'Emit stable machine-readable JSON')
    .option('-q, --quiet', 'Only print errors')
    .option('-V, --verbose', 'Show diagnostic details');
  const init = vi.fn(async () => ({ kind: 'kit.init', data: { ok: true }, message: 'installed' }));
  const uninstall = vi.fn(async () => ({ kind: 'kit.uninstall', data: { ok: true }, message: 'removed' }));
  registerKitLifecycleCommands(cli, { init: { execute: init }, uninstall: { execute: uninstall } });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  return { cli, init, uninstall };
}

async function run(cli: ReturnType<typeof cac>, argv: string[]): Promise<void> {
  cli.parse(['node', 'ak', ...argv], { run: false });
  await cli.runMatchedCommand();
}

describe('registerKitLifecycleCommands', () => {
  it('routes init with validated lifecycle options and global confirmation', async () => {
    const { cli, init } = cliFixture();
    await run(cli, [
      'init',
      'engineer',
      '--runtime',
      'codex',
      '--channel',
      'beta',
      '--scope',
      'project',
      '--project-dir',
      '/workspace/project',
      '--yes',
      '--json',
    ]);

    expect(init).toHaveBeenCalledWith({
      kitId: 'engineer',
      runtime: 'codex',
      channel: 'beta',
      scope: 'project',
      projectDirectory: '/workspace/project',
      yes: true,
      noInteractive: true,
    });
    expect(process.stdout.write).toHaveBeenCalledWith(
      `${JSON.stringify({ schema_version: 1, kind: 'kit.init', data: { ok: true } })}\n`,
    );
  });

  it('routes uninstall by exact registry ID without inferring npm removal', async () => {
    const { cli, uninstall } = cliFixture();
    await run(cli, ['uninstall', '--installation-id', 'global:codex:engineer', '--yes', '--json']);

    expect(uninstall).toHaveBeenCalledWith({
      installationId: 'global:codex:engineer',
      yes: true,
      noInteractive: true,
    });
  });

  it('routes an unambiguous kit/runtime/scope selector', async () => {
    const { cli, uninstall } = cliFixture();
    await run(cli, ['uninstall', 'engineer', '--runtime', 'cursor', '--scope', 'global', '--yes']);

    expect(uninstall).toHaveBeenCalledWith({
      kitId: 'engineer',
      runtime: 'cursor',
      scope: 'global',
      yes: true,
      noInteractive: false,
    });
  });

  it('renders invalid lifecycle options through the standard error contract', async () => {
    const { cli, init } = cliFixture();
    await run(cli, ['init', 'engineer', '--scope', 'machine', '--json']);

    expect(init).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining('"error_code":"invalid_input"'));
  });
});
