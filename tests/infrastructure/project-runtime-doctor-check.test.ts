import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UninstallUseCase } from '../../src/application/uninstall-use-case.js';
import { LocalFilesystemTransaction } from '../../src/infrastructure/filesystem/local-filesystem-transaction.js';
import { checkClaudeProjectRuntimes } from '../../src/infrastructure/runtime/project-runtime-doctor-check.js';
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

describe('Claude project runtime doctor check', () => {
  it('reports a verified active project plugin', async () => {
    const fixture = await installedFixture();

    await expect(
      checkClaudeProjectRuntimes(fixture.store, fixture.client),
    ).resolves.toMatchObject({
      status: 'ok',
      details: { projects: 1, plugins: 1, residues: 0 },
    });
  });

  it('warns about durable residue even after the marketplace is restored', async () => {
    const fixture = await installedFixture();
    const marketplacePath = path.join(
      fixture.project,
      '.claude-plugin',
      'marketplace.json',
    );
    const clean = await fs.readFile(marketplacePath);
    await fs.writeFile(marketplacePath, Buffer.concat([clean, Buffer.from('\n')]));
    await uninstall(fixture);
    await fs.writeFile(marketplacePath, clean);

    await expect(
      checkClaudeProjectRuntimes(fixture.store, fixture.client),
    ).resolves.toMatchObject({
      status: 'warn',
      details: { projects: 1, plugins: 0, residues: 1 },
    });
  });

  it('fails when a residue is still installed in Claude Code', async () => {
    const fixture = await installedFixture();
    const marketplacePath = path.join(
      fixture.project,
      '.claude-plugin',
      'marketplace.json',
    );
    await fs.appendFile(marketplacePath, '\n');
    await uninstall(fixture);
    fixture.client.plugins.set('ak-engineer@agentkit-local', {
      installed: true,
      enabled: true,
      version: '1.2.3',
    });

    await expect(
      checkClaudeProjectRuntimes(fixture.store, fixture.client),
    ).resolves.toMatchObject({
      status: 'fail',
      summary: expect.stringMatching(/reports residue .* as installed/i),
    });
  });

  it('cross-checks active ownership against the global kit registry', async () => {
    const fixture = await installedFixture();
    const registry = await fixture.store.load();
    await fixture.store.save({ ...registry, kits: {} });

    await expect(
      checkClaudeProjectRuntimes(fixture.store, fixture.client),
    ).resolves.toMatchObject({
      status: 'fail',
      summary: expect.stringMatching(/global kit registry/i),
    });
  });

  it('requires the provider marketplace to be absent after a clean last uninstall', async () => {
    const fixture = await installedFixture();
    await uninstall(fixture);

    await expect(
      checkClaudeProjectRuntimes(fixture.store, fixture.client),
    ).resolves.toMatchObject({ status: 'ok' });

    fixture.client.marketplaceKnown = true;
    await expect(
      checkClaudeProjectRuntimes(fixture.store, fixture.client),
    ).resolves.toMatchObject({
      status: 'fail',
      summary: expect.stringMatching(/empty AgentKit marketplace/i),
    });
  });
});

async function installedFixture() {
  const fixture = await createLifecycleFixture();
  roots.push(fixture.root);
  await createInit(fixture, '1.2.3').useCase.execute({
    kitId: 'engineer',
    runtime: 'claude-code',
    channel: 'stable',
    scope: 'project',
    projectDirectory: fixture.project,
    yes: true,
    noInteractive: true,
  });
  return fixture;
}

async function uninstall(
  fixture: Awaited<ReturnType<typeof createLifecycleFixture>>,
): Promise<void> {
  const useCase = new UninstallUseCase(
    fixture.paths,
    fixture.store,
    new LocalFilesystemTransaction(),
    prompts(),
    () => false,
    new ClaudeCodeProjectPluginProjector(fixture.client),
  );
  await useCase.execute({
    kitId: 'engineer',
    yes: true,
    noInteractive: true,
  });
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
