import type { CAC } from 'cac';
import type { InitUseCase } from '../application/init-use-case.js';
import type { KitScope } from '../application/kit-install-plan.js';
import type { UninstallUseCase } from '../application/uninstall-use-case.js';
import { AkError, EXIT_CODES } from '../domain/contracts/ak-error.js';
import type {
  RegistryChannel,
  RegistryRuntime,
} from '../domain/registry/remote-registry-manifest.js';
import { executeCommand } from './execute-command.js';
import { normalizeGlobalOptions } from './global-options.js';

import type { ExportUseCase } from '../application/export-use-case.js';

export interface KitLifecycleApplication {
  init: Pick<InitUseCase, 'execute'>;
  uninstall: Pick<UninstallUseCase, 'execute'>;
  exportKit?: Pick<ExportUseCase, 'execute'>;
}

interface LifecycleOptions {
  channel?: string;
  from?: string;
  installationId?: string;
  interactive?: boolean;
  json?: boolean;
  kit?: string;
  noInteractive?: boolean;
  output?: string;
  projectDir?: string;
  quiet?: boolean;
  runtime?: string;
  scope?: string;
  verbose?: boolean;
  yes?: boolean;
}

export function registerKitLifecycleCommands(cli: CAC, app: KitLifecycleApplication): void {
  cli
    .command('init [kit]', 'Install or update a verified AgentKit kit')
    .option('--kit <kit>', 'Kit ID (alternative to the positional kit)')
    .option('--from <path>', 'Path to local kit export (.zip, .tar.gz, or directory)')
    .option('--runtime <runtime>', 'Runtime: claude-code, codex, or cursor')
    .option('--channel <channel>', 'Release channel: dev, beta, or stable')
    .option('--scope <scope>', 'Install scope: global or project')
    .option('--project-dir <path>', 'Project directory for project scope')
    .action(async (positionalKit: string | undefined, raw: LifecycleOptions) => {
      const options = normalizeGlobalOptions(raw);
      await executeCommand(options, () => {
        const scope = parseScope(raw.scope ?? 'project');
        return app.init.execute({
          kitId: parseKitId(raw.kit ?? positionalKit ?? 'engineer'),
          runtime: parseRuntime(raw.runtime ?? 'claude-code'),
          channel: parseChannel(raw.channel ?? 'stable'),
          scope,
          ...(scope === 'project'
            ? { projectDirectory: raw.projectDir ? raw.projectDir : process.cwd() }
            : {}),
          ...(raw.from ? { from: raw.from } : {}),
          yes: options.yes,
          noInteractive: options.noInteractive,
        });
      });
    });

  cli
    .command('export [kit]', 'Download and export a verified kit archive to a local file')
    .option('--kit <kit>', 'Kit ID (default: engineer)')
    .option('--output <path>', 'Destination file path (e.g. ./engineer.tar.gz)')
    .option('--runtime <runtime>', 'Runtime: claude-code, codex, or cursor')
    .option('--channel <channel>', 'Release channel: dev, beta, or stable')
    .action(async (positionalKit: string | undefined, raw: LifecycleOptions) => {
      const options = normalizeGlobalOptions(raw);
      await executeCommand(options, () => {
        if (!app.exportKit) throw invalid('Export feature is unavailable in this context.');
        return app.exportKit.execute({
          kitId: parseKitId(raw.kit ?? positionalKit ?? 'engineer'),
          runtime: parseRuntime(raw.runtime ?? 'claude-code'),
          channel: parseChannel(raw.channel ?? 'stable'),
          ...(raw.output ? { outputPath: raw.output } : {}),
        });
      });
    });

  cli
    .command('uninstall [kit]', 'Safely remove one installed kit')
    .option('--installation-id <id>', 'Exact installed-kit registry ID')
    .option('--runtime <runtime>', 'Limit selection to a runtime')
    .option('--scope <scope>', 'Limit selection to global or project scope')
    .option('--project-dir <path>', 'Limit selection to a project directory')
    .action(async (positionalKit: string | undefined, raw: LifecycleOptions) => {
      const options = normalizeGlobalOptions(raw);
      await executeCommand(options, () =>
        app.uninstall.execute({
          ...(raw.installationId ? { installationId: raw.installationId } : {}),
          ...(positionalKit ? { kitId: parseKitId(positionalKit) } : {}),
          ...(raw.runtime ? { runtime: parseRuntime(raw.runtime) } : {}),
          ...(raw.scope ? { scope: parseScope(raw.scope) } : {}),
          ...(raw.projectDir ? { projectDirectory: raw.projectDir } : {}),
          yes: options.yes,
          noInteractive: options.noInteractive,
        }),
      );
    });
}

function parseKitId(value: string | undefined): string {
  if (value && /^[a-z0-9-]+$/u.test(value)) return value;
  throw invalid('Kit ID is required and may contain lowercase letters, numbers, and hyphens.');
}

function parseRuntime(value: string): RegistryRuntime {
  if (value === 'claude-code' || value === 'codex' || value === 'cursor') return value;
  throw invalid('Runtime must be claude-code, codex, or cursor.');
}

function parseChannel(value: string): RegistryChannel {
  if (value === 'dev' || value === 'beta' || value === 'stable') return value;
  throw invalid('Channel must be dev, beta, or stable.');
}

function parseScope(value: string): KitScope {
  if (value === 'global' || value === 'project') return value;
  throw invalid('Scope must be global or project.');
}

function invalid(message: string): AkError {
  return new AkError(message, {
    code: 'invalid_input',
    exitCode: EXIT_CODES.invalidInput,
  });
}
