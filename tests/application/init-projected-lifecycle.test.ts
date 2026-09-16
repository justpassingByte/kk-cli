import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FilesystemTransactionPlan } from '../../src/domain/lifecycle/filesystem-transaction.js';
import { LocalFilesystemTransaction } from '../../src/infrastructure/filesystem/local-filesystem-transaction.js';
import {
  createInit,
  createLifecycleFixture,
} from '../helpers/claude-project-lifecycle-fixture.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('projected Claude Code init lifecycle', { timeout: 30_000 }, () => {
  it('rejects unsupported targets before registry resolution or mutation', async () => {
    const fixture = await createLifecycleFixture();
    roots.push(fixture.root);
    const { useCase, resolver } = createInit(fixture, '1.2.3');

    await expect(
      useCase.execute({
        kitId: 'engineer',
        runtime: 'codex',
        channel: 'stable',
        scope: 'project',
        projectDirectory: fixture.project,
        yes: true,
        noInteractive: true,
      }),
    ).rejects.toMatchObject({ code: 'unsupported_environment' });

    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(await fixture.store.load()).toEqual({ version: 1, kits: {} });
    expect(fixture.client.operations).toEqual([]);
  });

  it('commits payload and both ownership layers only after provider verification', async () => {
    const fixture = await createLifecycleFixture();
    roots.push(fixture.root);
    const { useCase } = createInit(fixture, '1.2.3');

    const result = await useCase.execute(input(fixture.project));

    expect(result.kind).toBe('kit.init');
    await expect(
      fs.readFile(
        path.join(fixture.project, 'ak-engineer', '.claude-plugin', 'plugin.json'),
        'utf8',
      ),
    ).resolves.toContain('1.2.3');
    await expect(
      fs.stat(path.join(fixture.project, '.kk', 'runtime-ownership.json')),
    ).resolves.toBeDefined();
    const registry = await fixture.store.load();
    expect(Object.keys(registry.kits)).toHaveLength(1);
    expect(Object.keys(registry.projects ?? {})).toHaveLength(1);
    expect(fixture.client.plugins.get('ak-engineer@agentkit-local')).toMatchObject({
      installed: true,
      enabled: true,
      version: '1.2.3',
    });
  });

  it('rolls back every file and provider object when activation verification fails', async () => {
    const fixture = await createLifecycleFixture();
    roots.push(fixture.root);
    fixture.client.failVerification = true;
    const { useCase } = createInit(fixture, '1.2.3');

    await expect(useCase.execute(input(fixture.project))).rejects.toMatchObject({
      code: 'runtime_error',
    });

    await expect(
      fs.stat(path.join(fixture.project, 'ak-engineer', 'kit.yaml')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fs.stat(path.join(fixture.project, '.claude-plugin', 'marketplace.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fs.stat(path.join(fixture.project, '.kk', 'runtime-ownership.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fixture.store.load()).toEqual({ version: 1, kits: {} });
    expect(fixture.client.marketplaceKnown).toBe(false);
    expect(fixture.client.plugins.get('ak-engineer@agentkit-local')).toMatchObject({
      installed: false,
    });
  });

  it('refuses a foreign plugin file without invoking Claude Code', async () => {
    const fixture = await createLifecycleFixture();
    roots.push(fixture.root);
    await fs.mkdir(path.join(fixture.project, 'ak-engineer'), { recursive: true });
    await fs.writeFile(
      path.join(fixture.project, 'ak-engineer', 'kit.yaml'),
      'foreign: true\n',
    );
    const { useCase } = createInit(fixture, '1.2.3');

    await expect(useCase.execute(input(fixture.project))).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(
      await fs.readFile(path.join(fixture.project, 'ak-engineer', 'kit.yaml'), 'utf8'),
    ).toBe('foreign: true\n');
    expect(fixture.client.operations).toEqual([]);
  });

  it('restores old files and cached provider version after a registry failure', async () => {
    const fixture = await createLifecycleFixture();
    roots.push(fixture.root);
    await createInit(fixture, '1.2.3').useCase.execute(input(fixture.project));
    const transaction = new RegistryFailingTransaction();
    const { useCase } = createInit(fixture, '1.3.0', transaction);

    await expect(useCase.execute(input(fixture.project))).rejects.toThrow(
      /injected registry failure/i,
    );

    expect(
      await fs.readFile(
        path.join(fixture.project, 'ak-engineer', '.claude-plugin', 'plugin.json'),
        'utf8',
      ),
    ).toContain('1.2.3');
    expect(fixture.client.plugins.get('ak-engineer@agentkit-local')).toMatchObject({
      installed: true,
      enabled: true,
      version: '1.2.3',
    });
    expect(Object.values((await fixture.store.load()).kits)[0]?.kitVersion).toBe(
      '1.2.3',
    );
  });

  it('refuses to adopt an orphan ownership manifest without a kit record', async () => {
    const fixture = await createLifecycleFixture();
    roots.push(fixture.root);
    await createInit(fixture, '1.2.3').useCase.execute(input(fixture.project));
    const registry = await fixture.store.load();
    await fixture.store.save({
      ...registry,
      kits: {},
    });
    const start = fixture.client.operations.length;

    await expect(
      createInit(fixture, '1.3.0').useCase.execute(input(fixture.project)),
    ).rejects.toThrow(/manifest exists without a matching installed-kit registry/i);

    expect(fixture.client.operations.slice(start)).toEqual([]);
    expect(
      await fs.readFile(
        path.join(fixture.project, 'ak-engineer', '.claude-plugin', 'plugin.json'),
        'utf8',
      ),
    ).toContain('1.2.3');
  });

  it('refuses a registry and manifest version mismatch', async () => {
    const fixture = await createLifecycleFixture();
    roots.push(fixture.root);
    await createInit(fixture, '1.2.3').useCase.execute(input(fixture.project));
    const registry = await fixture.store.load();
    const [installationId, record] = Object.entries(registry.kits)[0] as [
      string,
      (typeof registry.kits)[string],
    ];
    await fixture.store.save({
      ...registry,
      kits: {
        ...registry.kits,
        [installationId]: { ...record, kitVersion: '9.9.9' },
      },
    });
    const start = fixture.client.operations.length;

    await expect(
      createInit(fixture, '1.3.0').useCase.execute(input(fixture.project)),
    ).rejects.toThrow(/registry and ownership manifest do not describe the same/i);

    expect(fixture.client.operations.slice(start)).toEqual([]);
  });
});

class RegistryFailingTransaction extends LocalFilesystemTransaction {
  override run(plan: FilesystemTransactionPlan) {
    return super.run({
      ...plan,
      hooks: {
        ...plan.hooks,
        beforeMutation: async (mutation) => {
          await plan.hooks?.beforeMutation?.(mutation);
          if (mutation.kind === 'registry') {
            throw new Error('injected registry failure');
          }
        },
      },
    });
  }
}

function input(projectDirectory: string) {
  return {
    kitId: 'engineer',
    runtime: 'claude-code' as const,
    channel: 'stable' as const,
    scope: 'project' as const,
    projectDirectory,
    yes: true,
    noInteractive: true,
  };
}
