export interface CommandResult<T = Record<string, unknown>> {
  kind: string;
  data: T;
  message: string;
  humanLines?: string[];
  silent?: boolean;
}

export interface GlobalOptions {
  json: boolean;
  noInteractive: boolean;
  quiet: boolean;
  verbose: boolean;
  yes: boolean;
}
