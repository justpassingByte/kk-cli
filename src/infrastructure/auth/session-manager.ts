import { AkError, EXIT_CODES } from '../../domain/contracts/ak-error.js';
import type { CredentialStore, StoredCredential } from '../credentials/credential-types.js';
import type { AgentKitApiClient } from './agentkit-api-client.js';
import type { LoginResponse, RefreshResponse } from './auth-types.js';

const REFRESH_WINDOW_MS = 60_000;

export class SessionManager {
  constructor(
    private readonly store: CredentialStore,
    private readonly api: AgentKitApiClient,
    private readonly now: () => number = Date.now,
  ) {}

  async requireAccessToken(): Promise<string> {
    const credential = await this.store.load();
    if (!credential) {
      throw new AkError('You are not logged in.', {
        code: 'auth_required',
        exitCode: EXIT_CODES.dependency,
        remediation: 'Run ak login.',
      });
    }
    if (!shouldRefresh(credential, this.now())) return credential.accessToken;
    if (this.store.withExclusive) {
      return this.store.withExclusive(() => this.refreshUnderLock(false));
    }
    return this.refreshUnderLock(false);
  }

  async refreshAccessToken(staleAccessToken?: string): Promise<string> {
    if (this.store.withExclusive) {
      return this.store.withExclusive(() => this.refreshUnderLock(true, staleAccessToken));
    }
    return this.refreshUnderLock(true, staleAccessToken);
  }

  private async refreshUnderLock(force: boolean, staleAccessToken?: string): Promise<string> {
    const credential = await this.store.load();
    if (!credential) {
      throw new AkError('You are not logged in.', {
        code: 'auth_required',
        exitCode: EXIT_CODES.dependency,
        remediation: 'Run ak login.',
      });
    }
    if (
      (!force && !shouldRefresh(credential, this.now())) ||
      (force && staleAccessToken !== undefined && credential.accessToken !== staleAccessToken)
    ) {
      return credential.accessToken;
    }
    if (credential.refreshToken) {
      try {
        const response = await this.api.refresh(credential.refreshToken);
        if (!response.refreshToken || !response.refreshTokenExpiresAt) {
          throw new AkError(
            'AgentKit did not return the rotated refresh session.',
            {
              code: 'dependency_unavailable',
              exitCode: EXIT_CODES.dependency,
              remediation:
                'Your existing session was preserved. Retry, then run ak login if the server keeps returning an incomplete session.',
            },
          );
        }
        const refreshed = mergeLoginResponse(response, credential);
        await this.store.save(refreshed);
        return refreshed.accessToken;
      } catch (error) {
        if (!credential.apiKey) throw error;
      }
    }

    if (credential.apiKey) {
      const response = await this.api.loginWithApiKey(credential.apiKey);
      const refreshed = mergeLoginResponse(response, credential);
      await this.store.save(refreshed);
      return refreshed.accessToken;
    }

    throw new AkError('Your login has expired.', {
      code: 'auth_expired',
      exitCode: EXIT_CODES.dependency,
      remediation: 'Run ak login again.',
    });
  }
}

export function mergeLoginResponse(
  response: LoginResponse | RefreshResponse,
  previous?: StoredCredential,
): StoredCredential {
  const accessToken = response.accessToken ?? response.token;
  const accessTokenExpiresAt =
    response.accessTokenExpiresAt ?? expirationFromJwt(accessToken);
  const authMethod = response.authMethod ?? previous?.authMethod;
  const user = response.user ?? previous?.user;
  const deviceId = response.deviceId ?? previous?.deviceId;
  const sessionId =
    'sessionId' in response && response.sessionId
      ? response.sessionId
      : previous?.sessionId;
  const refreshToken =
    'refreshToken' in response ? response.refreshToken : undefined;
  const refreshTokenExpiresAt =
    'refreshTokenExpiresAt' in response
      ? response.refreshTokenExpiresAt
      : undefined;
  if (!authMethod || !user) {
    throw new AkError('AgentKit returned an incomplete login identity.', {
      code: 'dependency_unavailable',
      exitCode: EXIT_CODES.dependency,
      remediation: 'Retry the command. If this persists, run ak login again.',
    });
  }
  return {
    schemaVersion: 1,
    authMethod,
    accessToken,
    obtainedAt: new Date().toISOString(),
    user,
    ...(deviceId ? { deviceId } : {}),
    ...(refreshToken ? { refreshToken } : {}),
    ...(accessTokenExpiresAt ? { accessTokenExpiresAt } : {}),
    ...(refreshTokenExpiresAt ? { refreshTokenExpiresAt } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(previous?.apiKey ? { apiKey: previous.apiKey } : {}),
  };
}

function shouldRefresh(credential: StoredCredential, now: number): boolean {
  if (!credential.accessTokenExpiresAt) {
    return Boolean(credential.refreshToken || credential.apiKey);
  }
  const expiresAt = Date.parse(credential.accessTokenExpiresAt);
  return !Number.isFinite(expiresAt) || expiresAt - now <= REFRESH_WINDOW_MS;
}

function expirationFromJwt(token: string): string | undefined {
  const payload = token.split('.')[1];
  if (!payload) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      exp?: unknown;
    };
    if (typeof parsed.exp !== 'number' || !Number.isSafeInteger(parsed.exp) || parsed.exp <= 0) {
      return undefined;
    }
    return new Date(parsed.exp * 1_000).toISOString();
  } catch {
    return undefined;
  }
}
