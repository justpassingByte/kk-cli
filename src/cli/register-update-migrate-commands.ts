import type { CAC } from 'cac';
import type { MigrateUseCase } from '../application/migrate-use-case.js';
import type { UpdateUseCase } from '../application/update-use-case.js';
import { executeCommand } from './execute-command.js';
import { normalizeGlobalOptions } from './global-options.js';

export interface UpdateMigrateApplication {
  update: Pick<UpdateUseCase, 'execute'>;
  migrate: Pick<MigrateUseCase, 'execute'>;
}

interface UpdateOptions {
  interactive?: boolean;
  json?: boolean;
  noInteractive?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  yes?: boolean;
}

interface MigrateOptions extends UpdateOptions {
  projectDir?: string;
}

export function registerUpdateMigrateCommands(
  cli: CAC,
  app: UpdateMigrateApplication,
  trustedRuntimeReadyVersion?: string,
): void {
  cli
    .command('update', 'Update the kk runtime and each installed kit')
    .action(async (raw: UpdateOptions) => {
      const options = normalizeGlobalOptions(raw);
      await executeCommand(options, () =>
        app.update.execute({
          yes: options.yes,
          noInteractive: options.noInteractive,
          json: options.json,
          quiet: options.quiet,
          ...(trustedRuntimeReadyVersion
            ? { runtimeReadyVersion: trustedRuntimeReadyVersion }
            : {}),
        }),
      );
    });

  cli
    .command('migrate', 'Move safely from legacy ClaudeKit and the Go runtime')
    .option('--project-dir <path>', 'Project to inspect and receive replacement plugins')
    .action(async (raw: MigrateOptions) => {
      const options = normalizeGlobalOptions(raw);
      await executeCommand(options, () =>
        app.migrate.execute({
          yes: options.yes,
          noInteractive: options.noInteractive,
          projectDirectory: raw.projectDir || process.cwd(),
        }),
      );
    });
}
