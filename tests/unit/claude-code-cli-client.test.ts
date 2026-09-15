import { describe, expect, it, vi } from 'vitest';
import {
  ClaudeCodeCliClient,
  type ClaudeProcessRunner,
} from '../../src/infrastructure/runtime/claude-code-cli-client.js';

describe('ClaudeCodeCliClient', () => {
  it('passes spaces and unicode as single argv values with explicit cwd', async () => {
    const calls: Array<{
      executable: string;
      argv: string[];
      cwd: string;
    }> = [];
    const runner: ClaudeProcessRunner = vi.fn(async (executable, argv, options) => {
      calls.push({ executable, argv, cwd: options.cwd });
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const client = new ClaudeCodeCliClient(runner);
    const cwd = '/tmp/Project with spaces/日本語 🚀';

    await client.addMarketplace(cwd);
    await client.installPlugin(cwd, 'ak-engineer@agentkit-local');

    expect(calls).toEqual([
      {
        executable: 'claude',
        argv: ['plugin', 'marketplace', 'add', cwd, '--scope', 'project'],
        cwd,
      },
      {
        executable: 'claude',
        argv: [
          'plugin',
          'install',
          'ak-engineer@agentkit-local',
          '--scope',
          'project',
        ],
        cwd,
      },
    ]);
  });

  it('requires exact project ref to be installed and enabled', async () => {
    const outputs = [
      JSON.stringify({
        plugins: [
          {
            ref: 'ak-engineer@agentkit-local',
            scope: 'project',
            installed: true,
            enabled: true,
            version: '1.2.3',
          },
          {
            ref: 'ak-engineer@agentkit-local',
            scope: 'user',
            installed: true,
            enabled: false,
          },
        ],
      }),
      JSON.stringify({
        marketplaces: [
          {
            name: 'agentkit-local',
            source: 'directory',
            path: '/tmp/project',
          },
        ],
      }),
    ];
    const runner: ClaudeProcessRunner = vi.fn(async () => ({
      exitCode: 0,
      stdout: outputs.shift() ?? '{}',
      stderr: '',
    }));
    const client = new ClaudeCodeCliClient(runner);

    await expect(
      client.captureProviderState('/tmp/project', 'ak-engineer@agentkit-local'),
    ).resolves.toEqual({
      pluginInstalled: true,
      pluginEnabled: true,
      pluginVersion: '1.2.3',
      marketplaceKnown: true,
      marketplaceConflict: false,
      marketplaceHasOtherPlugins: false,
      marketplaceOtherPlugins: [],
    });
  });

  it('fails closed when JSON capability is unavailable', async () => {
    const runner: ClaudeProcessRunner = vi
      .fn<ClaudeProcessRunner>()
      .mockResolvedValueOnce({ exitCode: 0, stdout: '2.1.158', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'Usage: plugin list', stderr: '' })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'Usage: plugin marketplace list --json',
        stderr: '',
      });
    const client = new ClaudeCodeCliClient(runner);

    await expect(client.assertSupported('/tmp/project')).rejects.toMatchObject({
      code: 'unsupported_environment',
    });
  });
});
