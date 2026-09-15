import { normalizeError } from '../domain/contracts/ak-error.js';
import type { CommandResult, GlobalOptions } from '../domain/contracts/command-result.js';
import { renderError, renderResult } from '../presentation/render-result.js';

export async function executeCommand(
  options: GlobalOptions,
  action: () => Promise<CommandResult>,
): Promise<void> {
  try {
    renderResult(await action(), options);
  } catch (error) {
    const normalized = normalizeError(error);
    renderError(normalized, options);
    process.exitCode = normalized.exitCode;
  }
}
