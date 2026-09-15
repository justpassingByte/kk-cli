import type { CAC } from 'cac';
import type { Application } from '../composition-root.js';
import { executeCommand } from './execute-command.js';
import { normalizeGlobalOptions } from './global-options.js';

interface LoginOptions {
  email?: string;
  apiKey?: boolean;
  json?: boolean;
  noInteractive?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  yes?: boolean;
}

export function registerAuthCommands(cli: CAC, app: Application): void {
  cli
    .command('login', 'Log in with an email code or API key')
    .option('--email <email>', 'Send a login code to this email')
    .option('--api-key', 'Use an API key (prompted securely)')
    .action(async (raw: LoginOptions) => {
      const options = normalizeGlobalOptions(raw);
      await executeCommand(options, () =>
        app.login.execute({
          noInteractive: options.noInteractive,
          ...(raw.email ? { email: raw.email } : {}),
          ...(raw.apiKey ? { useApiKey: true } : {}),
          ...(raw.apiKey && process.env['AGENTKIT_API_KEY']
            ? { apiKey: process.env['AGENTKIT_API_KEY'] }
            : {}),
        }),
      );
    });

  cli.command('logout', 'Revoke this session and clear the saved login').action(async (raw) => {
    const options = normalizeGlobalOptions(raw);
    await executeCommand(options, () => app.logout.execute());
  });
}
