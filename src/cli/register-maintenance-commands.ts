import type { CAC } from 'cac';
import type { Application } from '../composition-root.js';
import { AkError, EXIT_CODES } from '../domain/contracts/ak-error.js';
import { executeCommand } from './execute-command.js';
import { normalizeGlobalOptions } from './global-options.js';

interface DoctorOptions {
  report?: 'file' | 'github' | 'email';
  submit?: string;
  yes?: boolean;
}

export function registerMaintenanceCommands(cli: CAC, app: Application): void {
  cli
    .command('doctor', 'Check this machine and explain how to fix problems')
    .option('--report <destination>', 'Preview a scrubbed report: file, github, or email')
    .option('--submit <report-id>', 'Send a previously reviewed report')
    .action(async (raw: DoctorOptions) => {
      const options = normalizeGlobalOptions(raw);
      await executeCommand(options, async () => {
        if (raw.submit) return app.diagnosticReport.submit(raw.submit, options.yes);
        if (raw.report) return app.diagnosticReport.prepare(validateDestination(raw.report));
        return app.doctor.execute();
      });
    });
}

function validateDestination(value: string): 'file' | 'github' | 'email' {
  if (value === 'file' || value === 'github' || value === 'email') return value;
  throw new AkError('Report destination must be file, github, or email.', {
    code: 'invalid_input',
    exitCode: EXIT_CODES.invalidInput,
    remediation: 'Use --report file, --report github, or --report email.',
  });
}
