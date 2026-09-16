import { randomUUID } from 'node:crypto';
import { KkError, EXIT_CODES } from '../domain/contracts/kk-error.js';
import type { CommandResult } from '../domain/contracts/command-result.js';
import type { AgentKitApiClient } from '../infrastructure/auth/agentkit-api-client.js';
import { mergeLoginResponse } from '../infrastructure/auth/session-manager.js';
import type { CredentialStore } from '../infrastructure/credentials/credential-types.js';
import type { PromptService } from '../presentation/prompt-service.js';

export interface LoginInput {
  email?: string;
  apiKey?: string;
  useApiKey?: boolean;
  noInteractive: boolean;
}

export class LoginUseCase {
  constructor(
    private readonly api: AgentKitApiClient,
    private readonly store: CredentialStore,
    private readonly prompts: PromptService,
  ) {}

  async execute(input: LoginInput): Promise<CommandResult> {
    if (input.email && (input.apiKey || input.useApiKey)) {
      throw new KkError('Choose either email or API key login, not both.', {
        code: 'invalid_input',
        exitCode: EXIT_CODES.invalidInput,
      });
    }

    const previous = await this.store.load();
    const method = await this.resolveMethod(input);
    if (method === 'api_key') {
      const apiKey = input.apiKey || (await this.requireInteractive(input, () => this.prompts.apiKey()));
      const response = await this.api.loginWithApiKey(apiKey);
      await this.store.save({ ...mergeLoginResponse(response), apiKey });
      return {
        kind: 'auth.login',
        data: { auth_method: 'api_key', email: response.user.email, session: 'api_key' },
        message: `Logged in as ${response.user.email}.`,
      };
    }

    const email =
      input.email ||
      (await this.requireInteractive(input, () => this.prompts.email(previous?.user.email)));
    await this.api.startOtp(email);
    const code = await this.requireInteractive(input, () => this.prompts.otp());
    const response = await this.api.verifyOtp(email, code.trim(), previous?.deviceId || randomUUID());
    const credential = mergeLoginResponse(response);
    await this.store.save(credential);
    return {
      kind: 'auth.login',
      data: {
        auth_method: 'email_otp',
        email: response.user.email,
        session: response.refreshToken ? 'long_lived' : 'legacy',
        refresh_expires_at: response.refreshTokenExpiresAt,
      },
      message: `Logged in as ${response.user.email}.`,
    };
  }

  private async resolveMethod(input: LoginInput): Promise<'email_otp' | 'api_key'> {
    if (input.apiKey || input.useApiKey) return 'api_key';
    if (input.email) return 'email_otp';
    return this.requireInteractive(input, () => this.prompts.chooseAuthMethod());
  }

  private async requireInteractive<T>(input: LoginInput, prompt: () => Promise<T>): Promise<T> {
    if (input.noInteractive || !process.stdin.isTTY) {
      throw new KkError('This login needs input, but the terminal is non-interactive.', {
        code: 'invalid_input',
        exitCode: EXIT_CODES.invalidInput,
        remediation:
          'Use --email in an interactive terminal, or set AGENTKIT_API_KEY and run kk login --api-key --no-interactive.',
      });
    }
    return prompt();
  }
}
