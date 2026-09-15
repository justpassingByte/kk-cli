import type { GlobalOptions } from '../domain/contracts/command-result.js';

interface RawOptions {
  interactive?: boolean;
  json?: boolean;
  noInteractive?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  yes?: boolean;
}

export function normalizeGlobalOptions(options: RawOptions): GlobalOptions {
  const json = Boolean(options.json);
  return {
    json,
    noInteractive: Boolean(options.noInteractive || options.interactive === false || json),
    quiet: Boolean(options.quiet),
    verbose: Boolean(options.verbose),
    yes: Boolean(options.yes),
  };
}
