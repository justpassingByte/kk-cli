import { describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../../src/infrastructure/auth/session-manager.js';
import type { CredentialStore, StoredCredential } from '../../src/infrastructure/credentials/credential-types.js';
import type { AgentKitApiClient } from '../../src/infrastructure/auth/agentkit-api-client.js';

describe('SessionManager', () => {
  it('rotates an expiring refresh token and persists the complete pair', async () => {
    const saved: StoredCredential[] = [];
    const credential: StoredCredential = {
      schemaVersion: 1,
      authMethod: 'email_otp',
      accessToken: 'old-access',
      accessTokenExpiresAt: '2026-01-01T00:00:30.000Z',
      refreshToken: 'old-refresh',
      user: { id: 'u1', email: 'user@example.com' },
    };
    const store: CredentialStore = {
      load: vi.fn(async () => credential),
      save: vi.fn(async (value) => {
        saved.push(value);
      }),
      clear: vi.fn(),
    };
    const api = {
      refresh: vi.fn(async () => ({
        token: 'new-access',
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        accessTokenExpiresAt: '2026-01-01T00:15:00.000Z',
        refreshTokenExpiresAt: '2026-01-31T00:00:00.000Z',
        deviceId: 'device-1',
        sessionId: 'session-1',
      })),
    } as unknown as AgentKitApiClient;

    const manager = new SessionManager(store, api, () => Date.parse('2026-01-01T00:00:00.000Z'));

    expect(await manager.requireAccessToken()).toBe('new-access');
    expect(saved[0]).toMatchObject({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      sessionId: 'session-1',
      authMethod: 'email_otp',
      user: credential.user,
    });
  });

  it('preserves session and device identity from a minimal rotation response', async () => {
    let current: StoredCredential = {
      schemaVersion: 1,
      authMethod: 'email_otp',
      accessToken: 'old-access',
      accessTokenExpiresAt: '2026-01-01T00:00:01.000Z',
      refreshToken: 'old-refresh',
      refreshTokenExpiresAt: '2026-01-31T00:00:00.000Z',
      sessionId: 'session-1',
      deviceId: 'device-1',
      user: { id: 'u1', email: 'user@example.com' },
    };
    const store: CredentialStore = {
      load: async () => current,
      save: async (value) => {
        current = value;
      },
      clear: vi.fn(),
    };
    const manager = new SessionManager(
      store,
      {
        refresh: vi.fn(async () => ({
          token: 'new-access',
          refreshToken: 'new-refresh',
          refreshTokenExpiresAt: '2026-01-31T00:00:00.000Z',
        })),
      } as unknown as AgentKitApiClient,
      () => Date.parse('2026-01-01T00:00:00.000Z'),
    );

    await expect(manager.requireAccessToken()).resolves.toBe('new-access');
    expect(current).toMatchObject({
      sessionId: 'session-1',
      deviceId: 'device-1',
      authMethod: 'email_otp',
      user: { id: 'u1', email: 'user@example.com' },
    });
  });

  it('re-mints an API-key access token when legacy credentials have no expiry', async () => {
    let current: StoredCredential = {
      schemaVersion: 1,
      authMethod: 'api_key',
      accessToken: 'legacy-access',
      apiKey: 'saved-api-key',
      user: { id: 'u1', email: 'user@example.com' },
    };
    const loginWithApiKey = vi.fn(async () => ({
      token: 'fresh-access',
      accessToken: 'fresh-access',
      accessTokenExpiresAt: '2026-01-01T00:15:00.000Z',
      authMethod: 'api_key' as const,
      user: current.user,
    }));
    const store: CredentialStore = {
      load: async () => current,
      save: async (value) => {
        current = value;
      },
      clear: vi.fn(),
    };
    const manager = new SessionManager(
      store,
      { loginWithApiKey } as unknown as AgentKitApiClient,
      () => Date.parse('2026-01-01T00:00:00.000Z'),
    );

    expect(await manager.requireAccessToken()).toBe('fresh-access');
    expect(loginWithApiKey).toHaveBeenCalledWith('saved-api-key');
    expect(current).toMatchObject({
      accessToken: 'fresh-access',
      accessTokenExpiresAt: '2026-01-01T00:15:00.000Z',
      apiKey: 'saved-api-key',
    });
  });

  it('serializes refresh rotation and re-reads credentials under the lock', async () => {
    let current: StoredCredential = {
      schemaVersion: 1,
      authMethod: 'email_otp',
      accessToken: 'old-access',
      accessTokenExpiresAt: '2026-01-01T00:00:01.000Z',
      refreshToken: 'old-refresh',
      user: { id: 'u1', email: 'user@example.com' },
    };
    let queue = Promise.resolve();
    const withExclusive: NonNullable<CredentialStore['withExclusive']> = async (action) => {
      const previous = queue;
      let release: () => void = () => {};
      queue = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await action();
      } finally {
        release();
      }
    };
    const refresh = vi.fn(async () => ({
      token: 'new-access',
      accessToken: 'new-access',
      accessTokenExpiresAt: '2026-01-01T00:15:00.000Z',
      refreshToken: 'new-refresh',
      refreshTokenExpiresAt: '2026-01-31T00:00:00.000Z',
      authMethod: 'email_otp' as const,
      user: current.user,
    }));
    const store: CredentialStore = {
      load: async () => current,
      save: async (value) => {
        current = value;
      },
      clear: vi.fn(),
      withExclusive,
    };
    const manager = new SessionManager(
      store,
      { refresh } as unknown as AgentKitApiClient,
      () => Date.parse('2026-01-01T00:00:00.000Z'),
    );

    await expect(
      Promise.all([manager.requireAccessToken(), manager.requireAccessToken()]),
    ).resolves.toEqual(['new-access', 'new-access']);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('rejects an access-only refresh without discarding the current session', async () => {
    let current: StoredCredential = {
      schemaVersion: 1,
      authMethod: 'email_otp',
      accessToken: 'old-access',
      accessTokenExpiresAt: '2026-01-01T00:00:01.000Z',
      refreshToken: 'old-refresh',
      refreshTokenExpiresAt: '2026-01-31T00:00:00.000Z',
      user: { id: 'u1', email: 'user@example.com' },
    };
    const save = vi.fn(async (value: StoredCredential) => {
      current = value;
    });
    const store: CredentialStore = {
      load: async () => current,
      save,
      clear: vi.fn(),
    };
    const manager = new SessionManager(
      store,
      {
        refresh: vi.fn(async () => ({
          token: 'new-access',
          accessToken: 'new-access',
          accessTokenExpiresAt: '2026-01-01T00:15:00.000Z',
          authMethod: 'email_otp' as const,
          deviceId: 'device-1',
          user: current.user,
        })),
      } as unknown as AgentKitApiClient,
      () => Date.parse('2026-01-01T00:00:00.000Z'),
    );

    await expect(manager.requireAccessToken()).rejects.toBeDefined();
    expect(save).not.toHaveBeenCalled();
    expect(current.refreshToken).toBe('old-refresh');
  });
});
