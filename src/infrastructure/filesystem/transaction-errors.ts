import { KkError, EXIT_CODES } from '../../domain/contracts/kk-error.js';

export function transactionConflict(message: string, cause?: unknown): KkError {
  const options: ConstructorParameters<typeof KkError>[1] = {
    code: 'conflict',
    exitCode: EXIT_CODES.conflict,
    remediation: 'Inspect the target and retry without replacing foreign or modified files.',
  };
  if (cause !== undefined) options.cause = cause;
  return new KkError(message, options);
}

export function transactionFailure(
  error: unknown,
  transactionId: string,
  snapshotPath: string,
  recoveryReceiptPath?: string,
): KkError {
  const details: Record<string, unknown> = {
    ...(error instanceof KkError ? error.details : undefined),
    transactionId,
    snapshotPath,
  };
  if (recoveryReceiptPath !== undefined) details.recoveryReceiptPath = recoveryReceiptPath;
  const rollbackRemediation =
    recoveryReceiptPath === undefined
      ? snapshotPath === ''
        ? 'No filesystem mutation was committed. Inspect the error and retry.'
        : 'The transaction was rolled back. Inspect the error and retry.'
      : `Rollback was incomplete. Recover from ${recoveryReceiptPath} before retrying.`;
  const remediation =
    error instanceof KkError && error.remediation !== undefined
      ? `${error.remediation} ${rollbackRemediation}`
      : rollbackRemediation;
  return new KkError(error instanceof Error ? error.message : 'Filesystem transaction failed.', {
    code: error instanceof KkError ? error.code : 'runtime_error',
    exitCode: error instanceof KkError ? error.exitCode : EXIT_CODES.runtime,
    remediation,
    details,
    cause: error,
  });
}
