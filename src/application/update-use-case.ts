import semver from 'semver';
import { AkError, EXIT_CODES } from '../domain/contracts/ak-error.js';
import type { CommandResult } from '../domain/contracts/command-result.js';
import type { InstalledKitRecord } from '../domain/kits/installed-kit-registry.js';
import type { InstalledKitStore } from '../infrastructure/installed-kits/installed-kit-store.js';
import type {
  NpmRuntimeManager,
  RuntimeInstall,
} from '../infrastructure/packages/npm-runtime-manager.js';
import type { FreshRuntimeHandoff } from '../infrastructure/packages/fresh-runtime-handoff.js';
import type { PromptService } from '../presentation/prompt-service.js';
import type { InitUseCase } from './init-use-case.js';

export interface UpdateInput {
  yes: boolean;
  noInteractive: boolean;
  json: boolean;
  quiet: boolean;
  runtimeReadyVersion?: string;
}

export class UpdateUseCase {
  constructor(
    private readonly currentVersion: string,
    private readonly runtime: NpmRuntimeManager,
    private readonly handoff: FreshRuntimeHandoff,
    private readonly store: InstalledKitStore,
    private readonly init: InitUseCase,
    private readonly prompts: PromptService,
    private readonly isInteractive: () => boolean = () => Boolean(process.stdin.isTTY),
    private readonly recoverLifecycle: () => Promise<unknown> = async () => undefined,
  ) {}

  async execute(input: UpdateInput): Promise<CommandResult> {
    await this.recoverLifecycle();
    const channel = semver.prerelease(this.currentVersion) ? 'beta' : 'latest';
    if (input.runtimeReadyVersion) {
      await this.runtime.assertActiveInstall(input.runtimeReadyVersion);
    } else if (await this.shouldUpdateRuntime(input, channel)) {
      const installed = await this.runtime.update(channel);
      if (installed.version !== this.currentVersion) {
        await this.launchFreshRuntime(installed, input);
        return {
          kind: 'update.handoff',
          data: { version: installed.version },
          message: '',
          silent: true,
        };
      }
    }

    const registry = await this.store.load();
    const records = Object.values(registry.kits).sort((left, right) =>
      left.installationId.localeCompare(right.installationId),
    );
    const updated: Array<Record<string, unknown>> = [];
    const skipped: string[] = [];
    const unsupported: string[] = [];
    const failures: Array<Record<string, string>> = [];
    for (const record of records) {
      if (!isBetaManagedProjectPlugin(record)) {
        unsupported.push(record.installationId);
        continue;
      }
      if (!(await this.shouldUpdateKit(record, input))) {
        skipped.push(record.installationId);
        continue;
      }
      try {
        const result = await this.init.execute({
          kitId: record.kit,
          runtime: record.runtime,
          channel: record.channel,
          scope: record.scope,
          ...(record.projectDirectory ? { projectDirectory: record.projectDirectory } : {}),
          yes: true,
          noInteractive: true,
        });
        updated.push(result.data);
      } catch (error) {
        failures.push({
          installation_id: record.installationId,
          error: error instanceof Error ? error.message : 'Unknown update error',
        });
      }
    }
    if (failures.length > 0) {
      throw new AkError('Some kits could not be updated.', {
        code: 'dependency_unavailable',
        exitCode: EXIT_CODES.dependency,
        remediation: 'Review the failed kits below, fix the first reported cause, then run ak update again.',
        details: { updated, skipped, failures },
      });
    }
    return {
      kind: 'update.complete',
      data: {
        runtime_version: input.runtimeReadyVersion || this.currentVersion,
        updated,
        skipped,
        unsupported,
      },
      message:
        updated.length === 0
          ? 'AgentKit is up to date.'
          : `Updated ${updated.length} installed kit${updated.length === 1 ? '' : 's'}.`,
      ...(unsupported.length
        ? {
            humanLines: [
              `${unsupported.length} legacy or unsupported installation(s) were preserved. Run ak migrate for guidance.`,
            ],
          }
        : {}),
    };
  }

  private async shouldUpdateRuntime(
    input: UpdateInput,
    channel: 'beta' | 'latest',
  ): Promise<boolean> {
    if (input.yes) return true;
    const latest = await this.runtime.latestVersion(channel);
    if (latest === this.currentVersion) return false;
    return this.confirm(
      input,
      `Update the ak runtime from ${this.currentVersion} to ${latest}?`,
    );
  }

  private async shouldUpdateKit(record: InstalledKitRecord, input: UpdateInput): Promise<boolean> {
    if (input.yes) return true;
    return this.confirm(
      input,
      `Update ${record.kit} for ${record.runtime} (${record.scope})?`,
    );
  }

  private async confirm(input: UpdateInput, message: string): Promise<boolean> {
    if (!input.noInteractive && this.isInteractive()) {
      return this.prompts.confirm(message, true);
    }
    throw new AkError('Update needs confirmation.', {
      code: 'cancelled',
      exitCode: EXIT_CODES.cancelled,
      remediation: 'Run ak update --yes for a non-interactive update.',
    });
  }

  private async launchFreshRuntime(
    installed: RuntimeInstall,
    input: UpdateInput,
  ): Promise<void> {
    const args = ['update'];
    if (input.yes) args.push('--yes');
    if (input.noInteractive) args.push('--no-interactive');
    if (input.json) args.push('--json');
    if (input.quiet) args.push('--quiet');
    await this.handoff.launch(installed, args);
  }
}

function isBetaManagedProjectPlugin(record: InstalledKitRecord): boolean {
  return (
    record.runtime === 'claude-code' &&
    record.scope === 'project' &&
    Boolean(record.projectDirectory) &&
    record.installRoot.endsWith(`ak-${record.kit}`)
  );
}
