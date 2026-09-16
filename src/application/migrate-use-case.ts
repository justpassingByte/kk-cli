import { KkError, EXIT_CODES } from '../domain/contracts/kk-error.js';
import type { CommandResult } from '../domain/contracts/command-result.js';
import type { LegacyCkDiscovery, LegacyCkFinding } from '../domain/migration/legacy-ck-types.js';
import type { KkExecutableCandidate } from '../infrastructure/packages/executable-discovery.js';
import type { PromptService } from '../presentation/prompt-service.js';
import type { InitUseCase } from './init-use-case.js';

export interface MigrateInput {
  yes: boolean;
  noInteractive: boolean;
  projectDirectory: string;
}

export class MigrateUseCase {
  constructor(
    private readonly discoverLegacy: (options: {
      project: string;
    }) => Promise<LegacyCkDiscovery>,
    private readonly discoverExecutables: () => Promise<KkExecutableCandidate[]>,
    private readonly init: InitUseCase,
    private readonly prompts: PromptService,
    private readonly recoverLifecycle: () => Promise<unknown> = async () => undefined,
  ) {}

  async execute(input: MigrateInput): Promise<CommandResult> {
    await this.recoverLifecycle();
    const [legacy, executables] = await Promise.all([
      this.discoverLegacy({ project: input.projectDirectory }),
      this.discoverExecutables(),
    ]);
    const replacements = replacementTargets(legacy.findings);
    const installed: Array<Record<string, unknown>> = [];
    const skipped: string[] = [];
    for (const target of replacements) {
      if (!(await this.confirmReplacement(target, input))) {
        skipped.push(target.family);
        continue;
      }
      const result = await this.init.execute({
        kitId: target.family,
        runtime: 'claude-code',
        channel: 'stable',
        scope: 'project',
        projectDirectory: input.projectDirectory,
        yes: true,
        noInteractive: true,
      });
      installed.push(result.data);
    }

    const unsupported = legacy.findings
      .filter((finding) => !isProjectClaudeReplacement(finding))
      .map((finding) => finding.path);
    const guidance = runtimeGuidance(executables);
    return {
      kind: 'migration.complete',
      data: {
        discovered: legacy.findings,
        warnings: legacy.warnings,
        replacements_installed: installed,
        replacements_skipped: skipped,
        preserved_legacy_paths: legacy.findings.map((finding) => finding.path),
        unsupported_legacy_paths: unsupported,
        executable_guidance: guidance,
      },
      message:
        installed.length > 0
          ? `Installed ${installed.length} verified AgentKit replacement${installed.length === 1 ? '' : 's'}; legacy files were preserved.`
          : legacy.findings.length > 0
            ? 'Migration scan finished. Legacy files were preserved.'
            : 'No legacy ClaudeKit installation was found.',
      humanLines: [
        ...guidance,
        ...(unsupported.length
          ? [
              `${unsupported.length} legacy path(s) need manual review because this beta supports Claude Code project plugins only.`,
            ]
          : []),
        ...(legacy.findings.length
          ? ['Legacy files were not deleted. Remove them only after verifying the new project plugin.']
          : []),
      ],
    };
  }

  private async confirmReplacement(
    target: { family: 'engineer' | 'marketing' },
    input: MigrateInput,
  ): Promise<boolean> {
    if (input.yes) return true;
    if (!input.noInteractive && process.stdin.isTTY) {
      return this.prompts.confirm(
        `Install the verified ${target.family} replacement in this Claude Code project?`,
        true,
      );
    }
    throw new KkError('Migration needs confirmation.', {
      code: 'cancelled',
      exitCode: EXIT_CODES.cancelled,
      remediation: 'Review the detected paths, then run kk migrate --yes.',
    });
  }
}

function replacementTargets(
  findings: LegacyCkFinding[],
): Array<{ family: 'engineer' | 'marketing' }> {
  const families = new Set<'engineer' | 'marketing'>();
  for (const finding of findings) {
    if (isProjectClaudeReplacement(finding)) families.add(finding.family);
  }
  return [...families].sort().map((family) => ({ family }));
}

function isProjectClaudeReplacement(
  finding: LegacyCkFinding,
): finding is LegacyCkFinding & { family: 'engineer' | 'marketing' } {
  return (
    finding.runtime === 'claude-code' &&
    finding.scope === 'project' &&
    finding.confidence === 'high' &&
    (finding.family === 'engineer' || finding.family === 'marketing')
  );
}

function runtimeGuidance(executables: KkExecutableCandidate[]): string[] {
  const npm = executables.filter((candidate) => candidate.kind === 'npm');
  const native = executables.filter(
    (candidate) => candidate.kind === 'legacy_native_candidate',
  );
  if (native.length === 0) return [];
  if (npm.length === 0) {
    return [
      'Install the npm runtime with: npm install --global github:justpassingByte/kk-cli',
      'Afterward, verify PATH order with: kk doctor',
    ];
  }
  return [
    'Both legacy and npm executables are on PATH. Keep both for now, then follow kk doctor PATH guidance.',
  ];
}
