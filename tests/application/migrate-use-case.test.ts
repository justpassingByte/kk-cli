import { describe, expect, it, vi } from 'vitest';
import { MigrateUseCase } from '../../src/application/migrate-use-case.js';
import type { InitUseCase } from '../../src/application/init-use-case.js';
import type { PromptService } from '../../src/presentation/prompt-service.js';

describe('MigrateUseCase', () => {
  it('installs only verified project Claude replacements and preserves every legacy path', async () => {
    const init = {
      execute: vi.fn(async ({ kitId }: { kitId: string }) => ({
        kind: 'kit.init',
        data: { kit: kitId },
        message: 'ok',
      })),
    };
    const discoverLegacy = vi.fn(async () => ({
      schemaVersion: 1 as const,
      warnings: [],
      findings: [
        finding('/project/.claude/plugins/claudekit-engineer', 'claude-code', 'project', 'engineer'),
        finding('/home/.agents/skills/ck-cook', 'codex', 'global', 'engineer'),
      ],
    }));
    const migrate = new MigrateUseCase(
      discoverLegacy,
      async () => [
        { path: '/usr/local/bin/ak', realPath: '/usr/local/bin/ak', kind: 'legacy_native_candidate' },
      ],
      init as unknown as InitUseCase,
      prompts(),
    );

    const result = await migrate.execute({
      yes: true,
      noInteractive: true,
      projectDirectory: '/project',
    });

    expect(init.execute).toHaveBeenCalledOnce();
    expect(init.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        kitId: 'engineer',
        runtime: 'claude-code',
        scope: 'project',
      }),
    );
    expect(result.data).toMatchObject({
      preserved_legacy_paths: [
        '/project/.claude/plugins/claudekit-engineer',
        '/home/.agents/skills/ck-cook',
      ],
      unsupported_legacy_paths: ['/home/.agents/skills/ck-cook'],
    });
  });

  it('runs recovery before legacy or executable discovery', async () => {
    const discoverLegacy = vi.fn();
    const discoverExecutables = vi.fn();
    const recoveryError = new Error('pending transaction is ambiguous');
    const migrate = new MigrateUseCase(
      discoverLegacy,
      discoverExecutables,
      {} as InitUseCase,
      prompts(),
      async () => {
        throw recoveryError;
      },
    );

    await expect(
      migrate.execute({
        yes: true,
        noInteractive: true,
        projectDirectory: '/project',
      }),
    ).rejects.toBe(recoveryError);
    expect(discoverLegacy).not.toHaveBeenCalled();
    expect(discoverExecutables).not.toHaveBeenCalled();
  });
});

function finding(
  path: string,
  runtime: 'claude-code' | 'codex',
  scope: 'global' | 'project',
  family: 'engineer' | 'marketing',
) {
  return {
    runtime,
    scope,
    family,
    kind: 'plugin' as const,
    path,
    confidence: 'high' as const,
    mutationSafe: false,
    reason: 'fixture',
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
