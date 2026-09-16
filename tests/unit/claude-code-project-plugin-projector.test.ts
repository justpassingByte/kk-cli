import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeProjectionInput } from '../../src/domain/runtime/runtime-projector.js';
import type { ProjectRuntimeOwnershipV1 } from '../../src/domain/runtime/project-runtime-ownership.js';
import { sha256Bytes } from '../../src/infrastructure/filesystem/file-hash.js';
import {
  ClaudeCodeProjectPluginProjector,
  mergeClaudeMarketplaceJson,
  removeClaudeMarketplacePluginJson,
} from '../../src/infrastructure/runtime/claude-code-project-plugin-projector.js';
import { serializeProjectRuntimeOwnership } from '../../src/infrastructure/runtime/project-runtime-ownership-store.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('ClaudeCodeProjectPluginProjector', () => {
  it('rejects unsupported runtime and scope before filesystem or Claude access', async () => {
    const client = createClient();
    const projector = new ClaudeCodeProjectPluginProjector(client);

    await expect(
      projector.prepare({
        ...baseInput('/does/not/exist', '/also/missing'),
        runtime: 'codex',
      }),
    ).rejects.toMatchObject({ code: 'unsupported_environment' });
    await expect(
      projector.prepare({
        ...baseInput('/does/not/exist', '/also/missing'),
        scope: 'global',
      }),
    ).rejects.toMatchObject({ code: 'unsupported_environment' });
    expect(client.assertSupported).not.toHaveBeenCalled();
  });

  it('rejects a plugin manifest whose identity or version mismatches the verified kit', async () => {
    const fixture = await createFixture({
      name: 'ak-marketing',
      version: '1.2.3',
    });
    const projector = new ClaudeCodeProjectPluginProjector(createClient());

    await expect(projector.prepare(baseInput(fixture.project, fixture.artifact))).rejects.toThrow(
      /name must be exactly "ak-engineer"/i,
    );

    await fs.writeFile(
      path.join(fixture.artifact, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'ak-engineer', version: '9.9.9' }),
    );
    await expect(projector.prepare(baseInput(fixture.project, fixture.artifact))).rejects.toThrow(
      /version must match/i,
    );
  });

  it('rejects an unowned existing marketplace without adopting it', async () => {
    const fixture = await createFixture();
    await fs.mkdir(path.join(fixture.project, '.claude-plugin'), { recursive: true });
    await fs.writeFile(
      path.join(fixture.project, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'agentkit-local',
        owner: { name: 'AgentKit', support: 'team@example.test' },
        custom: { retained: true },
        plugins: [
          { name: 'third-party', source: { source: 'github', repo: 'acme/plugin' }, extra: 1 },
          { name: 'ak-engineer', source: './old', note: 'keep' },
        ],
      }),
    );
    const projector = new ClaudeCodeProjectPluginProjector(createClient());

    await expect(
      projector.prepare(baseInput(fixture.project, fixture.artifact)),
    ).rejects.toThrow(/unowned project marketplace/i);
  });

  it('updates an owned marketplace while preserving unrelated fields and entries', async () => {
    const fixture = await createFixture();
    const marketplace = JSON.stringify({
      name: 'agentkit-local',
      owner: { name: 'AgentKit', support: 'team@example.test' },
      custom: { retained: true },
      plugins: [
        { name: 'third-party', source: { source: 'github', repo: 'acme/plugin' }, extra: 1 },
        { name: 'ak-engineer', source: './old', note: 'keep' },
      ],
    });
    await seedOwnership(fixture.project, marketplace, {
      'ak-engineer@agentkit-local': {
        kitId: 'engineer',
        version: '1.2.3',
        enabled: true,
      },
    });
    const client = createClient();
    Object.assign(client.state, {
      pluginInstalled: true,
      pluginEnabled: true,
      pluginVersion: '1.2.3',
      marketplaceKnown: true,
    });
    const projector = new ClaudeCodeProjectPluginProjector(client);

    const prepared = await projector.prepare(baseInput(fixture.project, fixture.artifact));

    expect(prepared.projectRoot).toBe(await fs.realpath(fixture.project));
    expect(prepared.projectionRoot).toBe(path.join(prepared.projectRoot, 'ak-engineer'));
    expect(prepared.pluginReference).toBe('ak-engineer@agentkit-local');
    expect(prepared.writes.map((write) => write.relativePath)).toEqual([
      'ak-engineer/.claude-plugin/plugin.json',
      'ak-engineer/skills/demo/SKILL.md',
      '.claude-plugin/marketplace.json',
    ]);
    expect(prepared.metadataWrites.map((write) => write.relativePath)).toEqual([
      '.kk/runtime-ownership.json',
    ]);
    const projectedMarketplace = JSON.parse(String(prepared.writes.at(-1)?.contents)) as {
      custom: unknown;
      owner: unknown;
      plugins: unknown[];
    };
    expect(projectedMarketplace.custom).toEqual({ retained: true });
    expect(projectedMarketplace.owner).toEqual({
      name: 'AgentKit',
      support: 'team@example.test',
    });
    expect(projectedMarketplace.plugins).toEqual([
      { name: 'third-party', source: { source: 'github', repo: 'acme/plugin' }, extra: 1 },
      { name: 'ak-engineer', source: './ak-engineer', note: 'keep' },
    ]);
  });

  it('fails verification and compensates only state introduced by this projection', async () => {
    const fixture = await createFixture();
    const client = createClient();
    const projector = new ClaudeCodeProjectPluginProjector(client);
    const prepared = await projector.prepare(baseInput(fixture.project, fixture.artifact));

    await prepared.externalStep.apply();
    client.state.pluginEnabled = false;
    await expect(prepared.externalStep.verify()).rejects.toThrow(/did not verify/i);
    await prepared.externalStep.compensate();

    expect(client.uninstallPlugin).toHaveBeenCalledWith(
      await fs.realpath(fixture.project),
      'ak-engineer@agentkit-local',
    );
    expect(client.removeMarketplace).toHaveBeenCalledWith(await fs.realpath(fixture.project));
  });

  it('preserves provider objects that existed before the transaction', async () => {
    const fixture = await createFixture();
    const marketplace = mergeClaudeMarketplaceJson(undefined, 'ak-engineer');
    await seedOwnership(fixture.project, marketplace, {
      'ak-engineer@agentkit-local': {
        kitId: 'engineer',
        version: '1.2.3',
        enabled: true,
      },
    });
    const client = createClient();
    client.state.pluginInstalled = true;
    client.state.pluginEnabled = true;
    client.state.marketplaceKnown = true;
    client.state.pluginVersion = '1.2.3';
    const projector = new ClaudeCodeProjectPluginProjector(client);
    const prepared = await projector.prepare(baseInput(fixture.project, fixture.artifact));

    await prepared.externalStep.apply();
    await prepared.externalStep.compensate();

    expect(client.uninstallPlugin).not.toHaveBeenCalled();
    expect(client.removeMarketplace).not.toHaveBeenCalled();
  });

  it('refuses provider drift before the first update mutation', async () => {
    const fixture = await createFixture();
    const marketplace = mergeClaudeMarketplaceJson(undefined, 'ak-engineer');
    await seedOwnership(fixture.project, marketplace, {
      'ak-engineer@agentkit-local': {
        kitId: 'engineer',
        version: '1.2.3',
        enabled: true,
      },
    });
    const client = createClient();
    Object.assign(client.state, {
      pluginInstalled: true,
      pluginEnabled: true,
      pluginVersion: '1.2.3',
      marketplaceKnown: true,
    });
    const projector = new ClaudeCodeProjectPluginProjector(client);
    const prepared = await projector.prepare(
      baseInput(fixture.project, fixture.artifact),
    );
    client.state.pluginEnabled = false;

    await expect(prepared.externalStep.apply()).rejects.toThrow(
      /provider state changed before updating/i,
    );
    await prepared.externalStep.compensate();

    expect(client.updateMarketplace).not.toHaveBeenCalled();
    expect(client.updatePlugin).not.toHaveBeenCalled();
    expect(client.state.pluginEnabled).toBe(false);
  });

  it('prepares uninstall before mutations and restores the exact provider state', async () => {
    const fixture = await createFixture();
    await fs.mkdir(path.join(fixture.project, '.claude-plugin'), { recursive: true });
    await fs.writeFile(
      path.join(fixture.project, '.claude-plugin', 'marketplace.json'),
      mergeClaudeMarketplaceJson(undefined, 'ak-engineer'),
    );
    await seedOwnership(
      fixture.project,
      mergeClaudeMarketplaceJson(undefined, 'ak-engineer'),
      {
        'ak-engineer@agentkit-local': {
          kitId: 'engineer',
          version: '1.2.3',
          enabled: false,
        },
      },
    );
    const client = createClient();
    client.state.pluginInstalled = true;
    client.state.pluginEnabled = false;
    client.state.marketplaceKnown = true;
    client.state.pluginVersion = '1.2.3';
    const projector = new ClaudeCodeProjectPluginProjector(client);

    const prepared = await projector.prepareUninstall({
      runtime: 'claude-code',
      scope: 'project',
      kitId: 'engineer',
      projectDirectory: fixture.project,
    });

    expect(prepared.externalStep).toMatchObject({
      position: 'before-mutations',
      compensateAfterRollback: true,
    });
    expect(prepared.writes).toHaveLength(1);
    expect(
      JSON.parse(String(prepared.writes[0]?.contents)).plugins,
    ).toEqual([]);

    await prepared.externalStep.apply();
    await prepared.externalStep.verify();
    await prepared.externalStep.compensate();

    expect(client.disablePlugin).toHaveBeenCalledWith(
      await fs.realpath(fixture.project),
      'ak-engineer@agentkit-local',
    );
    expect(client.state).toEqual({
      pluginInstalled: true,
      pluginEnabled: false,
      pluginVersion: '1.2.3',
      marketplaceKnown: true,
      marketplaceConflict: false,
      marketplaceHasOtherPlugins: false,
      marketplaceOtherPlugins: [],
    });
  });
});

describe('mergeClaudeMarketplaceJson', () => {
  it('collapses only the owned duplicate while preserving unrelated data', () => {
    const merged = mergeClaudeMarketplaceJson(
      JSON.stringify({
        extension: 42,
        plugins: [
          { name: 'ak-engineer', source: './one', first: true },
          { name: 'other', source: './other' },
          { name: 'ak-engineer', source: './duplicate' },
        ],
      }),
      'ak-engineer',
    );

    expect(JSON.parse(merged)).toEqual({
      extension: 42,
      name: 'agentkit-local',
      owner: { name: 'AgentKit' },
      plugins: [
        { name: 'ak-engineer', source: './ak-engineer', first: true },
        { name: 'other', source: './other' },
      ],
    });
  });
});

describe('removeClaudeMarketplacePluginJson', () => {
  it('removes only the exact AgentKit entry and preserves unrelated fields', () => {
    const removal = removeClaudeMarketplacePluginJson(
      JSON.stringify({
        name: 'agentkit-local',
        custom: { keep: true },
        plugins: [
          { name: 'ak-engineer', source: './ak-engineer', note: 'owned' },
          { name: 'ak-marketing', source: './ak-marketing' },
        ],
      }),
      'ak-engineer',
    );
    expect(JSON.parse(removal.contents)).toEqual({
      name: 'agentkit-local',
      custom: { keep: true },
      plugins: [{ name: 'ak-marketing', source: './ak-marketing' }],
    });
    expect(removal.remainingPlugins).toBe(1);
  });
});

function baseInput(projectDirectory: string, artifactDirectory: string): RuntimeProjectionInput {
  return {
    runtime: 'claude-code',
    scope: 'project',
    kitId: 'engineer',
    version: '1.2.3',
    projectDirectory,
    artifactDirectory,
  };
}

async function createFixture(
  manifest: Record<string, unknown> = { name: 'ak-engineer', version: '1.2.3' },
): Promise<{ project: string; artifact: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kk-projector-'));
  temporaryDirectories.push(root);
  const project = path.join(root, 'Project with spaces 🚀');
  const artifact = path.join(root, 'verified artifact');
  await fs.mkdir(path.join(project), { recursive: true });
  await fs.mkdir(path.join(artifact, '.claude-plugin'), { recursive: true });
  await fs.mkdir(path.join(artifact, 'skills', 'demo'), { recursive: true });
  await fs.writeFile(
    path.join(artifact, '.claude-plugin', 'plugin.json'),
    JSON.stringify(manifest),
  );
  await fs.writeFile(path.join(artifact, 'skills', 'demo', 'SKILL.md'), '# Demo\n');
  return { project, artifact };
}

async function seedOwnership(
  project: string,
  marketplaceContents: string,
  plugins: ProjectRuntimeOwnershipV1['plugins'],
): Promise<void> {
  await fs.mkdir(path.join(project, '.claude-plugin'), { recursive: true });
  await fs.writeFile(
    path.join(project, '.claude-plugin', 'marketplace.json'),
    marketplaceContents,
  );
  const ownership: ProjectRuntimeOwnershipV1 = {
    version: 1,
    runtime: 'claude-code',
    projectDirectory: await fs.realpath(project),
    marketplaceName: 'agentkit-local',
    marketplacePath: path.join(await fs.realpath(project), '.claude-plugin', 'marketplace.json'),
    marketplaceSha256: sha256Bytes(marketplaceContents),
    providerSource: { kind: 'directory', path: await fs.realpath(project) },
    plugins,
    residues: {},
    updatedAt: '2026-07-28T00:00:00.000Z',
  };
  await fs.mkdir(path.join(project, '.kk'), { recursive: true });
  await fs.writeFile(
    path.join(project, '.kk', 'runtime-ownership.json'),
    serializeProjectRuntimeOwnership(ownership),
  );
}

function createClient() {
  const state = {
    pluginInstalled: false,
    pluginEnabled: false,
    pluginVersion: '',
    marketplaceKnown: false,
    marketplaceConflict: false,
    marketplaceHasOtherPlugins: false,
    marketplaceOtherPlugins: [],
  };
  return {
    state,
    assertSupported: vi.fn(async () => undefined),
    captureProviderState: vi.fn(async () => ({
      pluginInstalled: state.pluginInstalled,
      pluginEnabled: state.pluginEnabled,
      ...(state.pluginVersion ? { pluginVersion: state.pluginVersion } : {}),
      marketplaceKnown: state.marketplaceKnown,
      marketplaceConflict: state.marketplaceConflict,
      marketplaceHasOtherPlugins: state.marketplaceHasOtherPlugins,
      marketplaceOtherPlugins: state.marketplaceOtherPlugins,
    })),
    addMarketplace: vi.fn(async () => {
      state.marketplaceKnown = true;
    }),
    updateMarketplace: vi.fn(async () => undefined),
    installPlugin: vi.fn(async () => {
      state.pluginInstalled = true;
      state.pluginEnabled = true;
      state.pluginVersion = '1.2.3';
    }),
    updatePlugin: vi.fn(async () => {
      state.pluginInstalled = true;
      state.pluginEnabled = true;
      state.pluginVersion = '1.2.3';
    }),
    uninstallPlugin: vi.fn(async () => {
      state.pluginInstalled = false;
      state.pluginEnabled = false;
      state.pluginVersion = '';
    }),
    disablePlugin: vi.fn(async () => {
      state.pluginEnabled = false;
    }),
    enablePlugin: vi.fn(async () => {
      state.pluginEnabled = true;
    }),
    removeMarketplace: vi.fn(async () => {
      state.marketplaceKnown = false;
    }),
  };
}
