import type { CommandResult } from '../domain/contracts/command-result.js';
import type { CredentialStore } from '../infrastructure/credentials/credential-types.js';

export interface SessionRevokeClient {
  revoke(accessToken: string): Promise<void>;
}

export interface AccessTokenProvider {
  requireAccessToken(): Promise<string>;
}

export class LogoutUseCase {
  constructor(
    private readonly api: SessionRevokeClient,
    private readonly store: CredentialStore,
    private readonly sessions: AccessTokenProvider,
  ) {}

  async execute(): Promise<CommandResult> {
    let remoteRevoked = false;
    let revokeError: unknown;

    try {
      const credential = await this.store.load();
      if (
        credential &&
        (credential.authMethod === 'email_otp' || credential.refreshToken)
      ) {
        await this.api.revoke(await this.sessions.requireAccessToken());
        remoteRevoked = true;
      }
    } catch (error) {
      revokeError = error;
    } finally {
      if (this.store.withExclusive) {
        await this.store.withExclusive(() => this.store.clear());
      } else {
        await this.store.clear();
      }
    }

    return {
      kind: 'auth.logout',
      data: {
        local_cleared: true,
        remote_revoked: remoteRevoked,
        remote_revoke_failed: revokeError !== undefined,
      },
      message: remoteRevoked
        ? 'Logged out on this device.'
        : revokeError
          ? 'Local login cleared. The old remote session may remain active until it expires.'
          : 'You were already logged out on this device.',
    };
  }
}
