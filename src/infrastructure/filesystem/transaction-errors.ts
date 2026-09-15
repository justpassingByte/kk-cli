import { AkError, EXIT_CODES } from '../../domain/contracts/ak-error.js';

export function transactionConflict(message: string, cause?: unknown): AkError {
  const options: ConstructorParameters<typeof AkError>[1] = {
    code: 'conflict',
    exitCode: EXIT_CODES.conflict,
    remediation: 'Inspect the target and retry without replacing foreign or modified files.',
  };
  if (cause !== undefined) options.cause = cause;
  return new AkError(message, options);
}

export function transactionFailure(
  error: unknown,
  transactionId: string,
  snapshotPath: string,
  recoveryReceiptPath?: string,
): AkError {
  const details: Record<string, unknown> = {
    ...(error instanceof AkError ? error.details : undefined),
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
    error instanceof AkError && error.remediation !== undefined
      ? `${error.remediation} ${rollbackRemediation}`
      : rollbackRemediation;
  return new AkError(error instanceof Error ? error.message : 'Filesystem transaction failed.', {
    code: error instanceof AkError ? error.code : 'runtime_error',
    exitCode: error instanceof AkError ? error.exitCode : EXIT_CODES.runtime,
    remediation,
    details,
    cause: error,
  });
}
