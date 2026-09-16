import { describe, expect, it, vi } from 'vitest';
import { UpdateUseCase } from '../../src/application/update-use-case.js';
import type { InitUseCase } from '../../src/application/init-use-case.js';
import type { InstalledKitStore } from '../../src/infrastructure/installed-kits/installed-kit-store.js';
import type { FreshRuntimeHandoff } from '../../src/infrastructure/packages/fresh-runtime-handoff.js';
import type { NpmRuntimeManager } from '../../src/infrastructure/packages/npm-runtime-manager.js';
import type { PromptService } from '../../src/presentation/prompt-service.js';

describe('UpdateUseCase', () => {
  it('hands off to the exact fresh runtime before touching installed kits', async () => {
    const init = { execute: vi.fn() };
    const launch = vi.fn(async () => undefined);
    const runtime = {
      update: vi.fn(async () => ({
        packageRoot: '/npm/kk',
        entrypoint: '/npm/kk/bin/kk.js',
        version: '0.1.0-beta.1',
        npmExecutable: 'npm',
      })),
    };
    const useCase = new UpdateUseCase(
      '0.1.0-beta.0',
      runtime as unknown as NpmRuntimeManager,
      { launch } as unknown as FreshRuntimeHandoff,
      { load: vi.fn() } as unknown as InstalledKitStore,
      init as unknown as InitUseCase,
      prompts(),
    );

    const result = await useCase.execute({
      yes: true,
      noInteractive: true,
      json: true,
      quiet: false,
    });

    expect(result).toMatchObject({ kind: 'update.handoff', silent: true });
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({ version: '0.1.0-beta.1' }),
      ['update', '--yes', '--no-interactive', '--json'],
    );
    expect(init.execute).not.toHaveBeenCalled();
  });

  it('preserves per-kit prompts after an interactive runtime handoff', async () => {
    const launch = vi.fn(async () => undefined);
    const confirm = vi.fn(async () => true);
    const runtime = {
      latestVersion: vi.fn(async () => '0.1.0-beta.1'),
      update: vi.fn(async () => ({
        packageRoot: '/npm/kk',
        entrypoint: '/npm/kk/bin/kk.js',
        version: '0.1.0-beta.1',
        npmExecutable: 'npm',
      })),
    };
    const useCase = new UpdateUseCase(
      '0.1.0-beta.0',
      runtime as unknown as NpmRuntimeManager,
      { launch } as unknown as FreshRuntimeHandoff,
      { load: vi.fn() } as unknown as InstalledKitStore,
      { execute: vi.fn() } as unknown as InitUseCase,
      { ...prompts(), confirm },
      () => true,
    );

    await useCase.execute({
      yes: false,
      noInteractive: false,
      json: false,
      quiet: false,
    });

    expect(confirm).toHaveBeenCalledOnce();
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({ version: '0.1.0-beta.1' }),
      ['update'],
    );
  });

  it('updates installed kits sequentially after fresh-runtime proof', async () => {
    const order: string[] = [];
    const records = {
      'project:one:claude-code:marketing': record('marketing'),
      'project:one:claude-code:engineer': record('engineer'),
    };
    const init = {
      execute: vi.fn(async ({ kitId }: { kitId: string }) => {
        order.push(kitId);
        return { kind: 'kit.init', data: { kit: kitId }, message: 'ok' };
      }),
    };
    const runtime = {
      assertActiveInstall: vi.fn(async () => undefined),
    };
    const useCase = new UpdateUseCase(
      '0.1.0-beta.1',
      runtime as unknown as NpmRuntimeManager,
      {} as FreshRuntimeHandoff,
      { load: async () => ({ version: 1, kits: records }) } as unknown as InstalledKitStore,
      init as unknown as InitUseCase,
      prompts(),
    );

    const result = await useCase.execute({
      yes: true,
      noInteractive: true,
      json: false,
      quiet: false,
      runtimeReadyVersion: '0.1.0-beta.1',
    });

    expect(order).toEqual(['engineer', 'marketing']);
    expect(result.data).toMatchObject({
      updated: [{ kit: 'engineer' }, { kit: 'marketing' }],
    });
  });

  it('recovers interrupted lifecycle state before checking or updating npm', async () => {
    const latestVersion = vi.fn();
    const update = vi.fn();
    const recoveryError = new Error('pending transaction is ambiguous');
    const useCase = new UpdateUseCase(
      '0.1.0-beta.0',
      { latestVersion, update } as unknown as NpmRuntimeManager,
      {} as FreshRuntimeHandoff,
      {} as InstalledKitStore,
      {} as InitUseCase,
      prompts(),
      () => false,
      async () => {
        throw recoveryError;
      },
    );

    await expect(
      useCase.execute({
        yes: true,
        noInteractive: true,
        json: false,
        quiet: false,
      }),
    ).rejects.toBe(recoveryError);
    expect(latestVersion).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});

function record(kit: string) {
  return {
    installationId: `project:one:claude-code:${kit}`,
    kit,
    kitVersion: '1.0.0',
    runtime: 'claude-code' as const,
    scope: 'project' as const,
    channel: 'stable' as const,
    projectDirectory: '/tmp/project',
    installRoot: `/tmp/project/ak-${kit}`,
    manifestPath: `/tmp/project/ak-${kit}/.kk/install-manifest.json`,
    files: [],
    installedAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
  };
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
