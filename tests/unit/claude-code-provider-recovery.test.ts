import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ClaudeProjectPluginRecovery } from '../../src/domain/lifecycle/filesystem-transaction.js';
import type { ClaudeProviderState } from '../../src/infrastructure/runtime/claude-code-cli-client.js';
import {
  restoreClaudeProviderState,
  type ClaudeProviderRecoveryClient,
} from '../../src/infrastructure/runtime/claude-code-provider-recovery.js';
import { sha256Bytes } from '../../src/infrastructure/filesystem/file-hash.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

const before: ClaudeProviderState = {
  pluginInstalled: false,
  pluginEnabled: false,
  marketplaceKnown: false,
  marketplaceConflict: false,
  marketplaceHasOtherPlugins: false,
  marketplaceOtherPlugins: [],
};
const after: ClaudeProviderState = {
  pluginInstalled: true,
  pluginEnabled: true,
  pluginVersion: '2.0.0',
  marketplaceKnown: true,
  marketplaceConflict: false,
  marketplaceHasOtherPlugins: false,
  marketplaceOtherPlugins: [],
};
const descriptor: ClaudeProjectPluginRecovery = {
  kind: 'claude-code-project-plugin',
  operation: 'install',
  marketplaceMutation: 'add',
  projectRoot: '/project',
  pluginReference: 'ak-engineer@agentkit-local',
  marketplaceBeforeAbsent: true,
  marketplaceAfterSha256: 'a'.repeat(64),
  before,
  after,
};

describe('Claude provider recovery', () => {
  it('does nothing when provider state already matches the desired image', async () => {
    const commit = await commitDescriptor();
    const client = new RecoveryClient(after);

    await restoreClaudeProviderState(client, commit, 'commit');

    expect(client.operations).toEqual([]);
  });

  it('rejects foreign version drift without mutating provider state', async () => {
    const foreign = { ...after, pluginVersion: '9.9.9' };
    const client = new RecoveryClient(foreign);

    await expect(
      restoreClaudeProviderState(client, descriptor, 'rollback'),
    ).rejects.toMatchObject({ code: 'conflict' });

    expect(client.operations).toEqual([]);
    expect(client.state).toEqual(foreign);
  });

  it('rejects marketplace file drift before the first provider command', async () => {
    const commit = await commitDescriptor();
    await fs.writeFile(
      path.join(commit.projectRoot, '.claude-plugin', 'marketplace.json'),
      '{"foreign":true}\n',
    );
    const client = new RecoveryClient(before);

    await expect(
      restoreClaudeProviderState(client, commit, 'commit'),
    ).rejects.toMatchObject({ code: 'conflict' });

    expect(client.operations).toEqual([]);
  });

  it('preserves a marketplace that became shared after the crash', async () => {
    const shared = {
      ...after,
      marketplaceHasOtherPlugins: true,
      marketplaceOtherPlugins: [
        {
          reference: 'ak-marketing@agentkit-local',
          enabled: true,
          version: '1.0.0',
        },
      ],
    };
    const client = new RecoveryClient(shared);

    await expect(
      restoreClaudeProviderState(client, descriptor, 'rollback'),
    ).rejects.toThrow(/changed outside|shared/i);

    expect(client.operations).toEqual([]);
    expect(client.state).toEqual(shared);
  });

  it.each([1, 2, 3, 4])(
    'resumes commit recovery after interruption at provider mutation %s',
    async (failureOperation) => {
      const commit = await commitDescriptor();
      const client = new RecoveryClient(before, failureOperation);

      await expect(
        restoreClaudeProviderState(client, commit, 'commit'),
      ).rejects.toThrow(/injected interruption/i);

      client.failureOperation = undefined;
      await restoreClaudeProviderState(client, commit, 'commit');
      expect(client.state).toEqual(after);
    },
  );

  it.each([1, 2])(
    'resumes rollback recovery after interruption at provider mutation %s',
    async (failureOperation) => {
      const client = new RecoveryClient(after, failureOperation);

      await expect(
        restoreClaudeProviderState(client, descriptor, 'rollback'),
      ).rejects.toThrow(/injected interruption/i);

      client.failureOperation = undefined;
      await restoreClaudeProviderState(client, descriptor, 'rollback');
      expect(client.state).toEqual(before);
    },
  );
});

async function commitDescriptor(): Promise<ClaudeProjectPluginRecovery> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kk-provider-recovery-'));
  temporaryDirectories.push(root);
  const contents = '{"name":"agentkit-local","plugins":[]}\n';
  await fs.mkdir(path.join(root, '.claude-plugin'));
  await fs.writeFile(
    path.join(root, '.claude-plugin', 'marketplace.json'),
    contents,
  );
  return {
    ...descriptor,
    projectRoot: root,
    marketplaceAfterSha256: sha256Bytes(contents),
  };
}

class RecoveryClient implements ClaudeProviderRecoveryClient {
  readonly operations: string[] = [];
  private mutationCount = 0;

  constructor(
    public state: ClaudeProviderState,
    public failureOperation?: number,
  ) {}

  async captureProviderState(): Promise<ClaudeProviderState> {
    return { ...this.state };
  }

  async addMarketplace(): Promise<void> {
    this.state = { ...this.state, marketplaceKnown: true };
    await this.mutated('marketplace:add');
  }

  async updateMarketplace(): Promise<void> {
    await this.mutated('marketplace:update');
  }

  async installPlugin(): Promise<void> {
    this.state = {
      ...this.state,
      pluginInstalled: true,
      pluginEnabled: false,
      pluginVersion: '2.0.0',
    };
    await this.mutated('plugin:install');
  }

  async updatePlugin(): Promise<void> {
    this.state = {
      ...this.state,
      pluginInstalled: true,
      pluginVersion: '2.0.0',
    };
    await this.mutated('plugin:update');
  }

  async uninstallPlugin(): Promise<void> {
    this.state = {
      ...this.state,
      pluginInstalled: false,
      pluginEnabled: false,
    };
    delete this.state.pluginVersion;
    await this.mutated('plugin:uninstall');
  }

  async enablePlugin(): Promise<void> {
    this.state = { ...this.state, pluginEnabled: true };
    await this.mutated('plugin:enable');
  }

  async disablePlugin(): Promise<void> {
    this.state = { ...this.state, pluginEnabled: false };
    await this.mutated('plugin:disable');
  }

  async removeMarketplace(): Promise<void> {
    this.state = {
      ...this.state,
      marketplaceKnown: false,
      marketplaceHasOtherPlugins: false,
      marketplaceOtherPlugins: [],
    };
    await this.mutated('marketplace:remove');
  }

  private async mutated(operation: string): Promise<void> {
    this.operations.push(operation);
    this.mutationCount += 1;
    if (this.mutationCount === this.failureOperation) {
      throw new Error('injected interruption');
    }
  }
}
