export const EXIT_CODES = {
  success: 0,
  runtime: 1,
  invalidInput: 2,
  cancelled: 3,
  dependency: 4,
  notFound: 5,
  conflict: 6,
  security: 7,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export type ErrorCode =
  | 'auth_required'
  | 'auth_expired'
  | 'cancelled'
  | 'conflict'
  | 'dependency_unavailable'
  | 'invalid_input'
  | 'network_error'
  | 'not_found'
  | 'permission_denied'
  | 'runtime_error'
  | 'security_error'
  | 'unsupported_environment';

export class KkError extends Error {
  readonly code: ErrorCode;
  readonly exitCode: ExitCode;
  readonly remediation: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    message: string,
    options: {
      code: ErrorCode;
      exitCode: ExitCode;
      remediation?: string;
      details?: Record<string, unknown>;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = 'KkError';
    this.code = options.code;
    this.exitCode = options.exitCode;
    this.remediation = options.remediation;
    this.details = options.details;
  }
}

export function normalizeError(error: unknown): KkError {
  if (error instanceof KkError) return error;
  return new KkError(error instanceof Error ? error.message : 'Unexpected error', {
    code: 'runtime_error',
    exitCode: EXIT_CODES.runtime,
    remediation: 'Run the command again with --verbose. If it still fails, run kk doctor.',
    cause: error,
  });
}
