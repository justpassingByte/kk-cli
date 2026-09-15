import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UninstallUseCase } from '../../src/application/uninstall-use-case.js';
import type { FilesystemTransactionPlan } from '../../src/domain/lifecycle/filesystem-transaction.js';
import { LocalFilesystemTransaction } from '../../src/infrastructure/filesystem/local-filesystem-transaction.js';
import { ClaudeCodeProjectPluginProjector } from '../../src/infrastructure/runtime/claude-code-project-plugin-projector.js';
import type { PromptService } from '../../src/presentation/prompt-service.js';
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

describe('projected Claude Code uninstall lifecycle', { timeout: 30_000 }, () => {
  it(
    'preserves the shared marketplace until the last owned plugin is removed',
    async () => {
      const fixture = await createLifecycleFixture();
      roots.push(fixture.root);
      await createInit(fixture, '1.2.3').useCase.execute(input(fixture.project));
      await createInit(fixture, '2.0.0', undefined, 'marketing').useCase.execute(
        input(fixture.project, 'marketing'),
      );
      const projector = new ClaudeCodeProjectPluginProjector(fixture.client);
      const uninstall = new UninstallUseCase(
        fixture.paths,
        fixture.store,
        new LocalFilesystemTransaction(),
        prompts(),
        () => false,
        projector,
      );

      await uninstall.execute({
        kitId: 'engineer',
        yes: true,
        noInteractive: true,
      });

      expect(fixture.client.marketplaceKnown).toBe(true);
      expect(fixture.client.plugins.get('ak-marketing@agentkit-local')).toMatchObject({
        installed: true,
        enabled: true,
      });
      await expect(
        fs.stat(path.join(fixture.project, 'ak-engineer')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      const marketplace = JSON.parse(
        await fs.readFile(
          path.join(fixture.project, '.claude-plugin', 'marketplace.json'),
          'utf8',
        ),
      ) as { plugins: Array<{ name: string }> };
      expect(marketplace.plugins.map(({ name }) => name)).toEqual(['ak-marketing']);

      await uninstall.execute({
        kitId: 'marketing',
        yes: true,
        noInteractive: true,
      });

      expect(fixture.client.marketplaceKnown).toBe(false);
      const registry = await fixture.store.load();
      expect(registry.kits).toEqual({});
      expect(Object.keys(registry.projects ?? {})).toHaveLength(1);
      const ownership = JSON.parse(
        await fs.readFile(
          path.join(fixture.project, '.agentkit', 'runtime-ownership.json'),
          'utf8',
        ),
      ) as {
        plugins: Record<string, unknown>;
        residues: Record<string, { kitId: string; version: string }>;
      };
      expect(ownership.plugins).toEqual({});
      expect(ownership.residues).toEqual({});
    },
  );

  it('deactivates the provider before deleting payload files', async () => {
    const fixture = await createLifecycleFixture();
    roots.push(fixture.root);
    await createInit(fixture, '1.2.3').useCase.execute(input(fixture.project));
    const events = fixture.client.operations;
    const start = events.length;
    const transaction = new RecordingTransaction(events);
    const uninstall = new UninstallUseCase(
      fixture.paths,
      fixture.store,
      transaction,
      prompts(),
      () => false,
      new ClaudeCodeProjectPluginProjector(fixture.client),
    );

    await uninstall.execute({
      kitId: 'engineer',
      yes: true,
      noInteractive: true,
    });

    const operationEvents = events.slice(start);
    expect(operationEvents[0]).toBe(
      'plugin:uninstall:ak-engineer@agentkit-local',
    );
    expect(operationEvents.findIndex((event) => event.startsWith('fs:'))).toBeGreaterThan(
      operationEvents.findIndex((event) => event.startsWith('plugin:uninstall:')),
    );
  });

  it('preserves a modified marketplace and records ownership residue', async () => {
    const fixture = await createLifecycleFixture();
    roots.push(fixture.root);
    await createInit(fixture, '1.2.3').useCase.execute(input(fixture.project));
    const marketplacePath = path.join(
      fixture.project,
      '.claude-plugin',
      'marketplace.json',
    );
    const clean = await fs.readFile(marketplacePath, 'utf8');
    const modified = `${clean}\n`;
    await fs.writeFile(marketplacePath, modified);
    const uninstall = new UninstallUseCase(
      fixture.paths,
      fixture.store,
      new LocalFilesystemTransaction(),
      prompts(),
      () => false,
      new ClaudeCodeProjectPluginProjector(fixture.client),
    );

    const result = await uninstall.execute({
      kitId: 'engineer',
      yes: true,
      noInteractive: true,
    });

    expect(await fs.readFile(marketplacePath, 'utf8')).toBe(modified);
    expect(result.data).toMatchObject({ shared_config_residue: true });
    expect(fixture.client.marketplaceKnown).toBe(true);
    const ownership = JSON.parse(
      await fs.readFile(
        path.join(fixture.project, '.agentkit', 'runtime-ownership.json'),
        'utf8',
      ),
    ) as {
      plugins: Record<string, unknown>;
      residues: Record<string, { kitId: string; version: string }>;
    };
    expect(ownership.plugins).toEqual({});
    expect(ownership.residues).toMatchObject({
      'ak-engineer@agentkit-local': {
        kitId: 'engineer',
        version: '1.2.3',
      },
    });

    await fs.writeFile(marketplacePath, clean);
    await createInit(fixture, '1.3.0').useCase.execute(input(fixture.project));
    const reconciled = JSON.parse(
      await fs.readFile(
        path.join(fixture.project, '.agentkit', 'runtime-ownership.json'),
        'utf8',
      ),
    ) as { residues: Record<string, unknown> };
    expect(reconciled.residues).toEqual({});
  });

  it('aborts without provider mutation when state changes during confirmation', async () => {
    const fixture = await createLifecycleFixture();
    roots.push(fixture.root);
    await createInit(fixture, '1.2.3').useCase.execute(input(fixture.project));
    const start = fixture.client.operations.length;
    const interactivePrompts = prompts();
    interactivePrompts.confirm = vi.fn(async () => {
      fixture.client.plugins.set('ak-engineer@agentkit-local', {
        installed: true,
        enabled: false,
        version: '1.2.3',
      });
      return true;
    });
    const uninstall = new UninstallUseCase(
      fixture.paths,
      fixture.store,
      new LocalFilesystemTransaction(),
      interactivePrompts,
      () => true,
      new ClaudeCodeProjectPluginProjector(fixture.client),
    );

    await expect(
      uninstall.execute({
        kitId: 'engineer',
        yes: false,
        noInteractive: false,
      }),
    ).rejects.toThrow(/provider state changed before uninstalling/i);

    expect(fixture.client.operations.slice(start)).toEqual([]);
    await expect(
      fs.stat(path.join(fixture.project, 'ak-engineer', 'kit.yaml')),
    ).resolves.toBeDefined();
    expect(Object.keys((await fixture.store.load()).kits)).toHaveLength(1);
  });
});

class RecordingTransaction extends LocalFilesystemTransaction {
  constructor(private readonly events: string[]) {
    super();
  }

  override run(plan: FilesystemTransactionPlan) {
    return super.run({
      ...plan,
      hooks: {
        ...plan.hooks,
        beforeMutation: async (mutation) => {
          await plan.hooks?.beforeMutation?.(mutation);
          this.events.push(`fs:${mutation.kind}:${mutation.relativePath}`);
        },
      },
    });
  }
}

function prompts(): PromptService {
  return {
    chooseAuthMethod: vi.fn(),
    email: vi.fn(),
    otp: vi.fn(),
    apiKey: vi.fn(),
    confirm: vi.fn(async () => true),
  };
}

function input(projectDirectory: string, kitId = 'engineer') {
  return {
    kitId,
    runtime: 'claude-code' as const,
    channel: 'stable' as const,
    scope: 'project' as const,
    projectDirectory,
    yes: true,
    noInteractive: true,
  };
}
