import pc from 'picocolors';
import type { KkError } from '../domain/contracts/kk-error.js';
import type { CommandResult, GlobalOptions } from '../domain/contracts/command-result.js';

export function renderResult(result: CommandResult, options: GlobalOptions): void {
  if (result.silent) return;
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ schema_version: 1, kind: result.kind, data: result.data })}\n`,
    );
    return;
  }
  if (options.quiet) return;
  process.stdout.write(`${pc.green('✓')} ${result.message}\n`);
  for (const line of result.humanLines ?? []) process.stdout.write(`${line}\n`);
}

export function renderError(error: KkError, options: GlobalOptions): void {
  if (options.json) {
    process.stderr.write(
      `${JSON.stringify({
        schema_version: 1,
        error: error.message,
        error_code: error.code,
        exit_code: error.exitCode,
        ...(error.remediation ? { remediation: error.remediation } : {}),
        ...(error.details ? { details: error.details } : {}),
      })}\n`,
    );
    return;
  }

  process.stderr.write(`${pc.red('Error:')} ${error.message}\n`);
  if (error.remediation) process.stderr.write(`${pc.dim('Next:')} ${error.remediation}\n`);
  if (options.verbose && error.cause instanceof Error) {
    process.stderr.write(`${pc.dim(error.cause.stack ?? error.cause.message)}\n`);
  }
}
