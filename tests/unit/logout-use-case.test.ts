import { describe, expect, it, vi } from 'vitest';
import { LogoutUseCase } from '../../src/application/logout-use-case.js';
import { AkError, EXIT_CODES } from '../../src/domain/contracts/ak-error.js';
import type { StoredCredential } from '../../src/infrastructure/credentials/credential-types.js';

const sessionCredential: StoredCredential = {
  schemaVersion: 1,
  authMethod: 'email_otp',
  accessToken: 'expired-access',
  refreshToken: 'refresh',
  sessionId: 'session',
  deviceId: 'device',
  user: { id: 'user', email: 'person@example.test' },
};

describe('LogoutUseCase', () => {
  it('refreshes before revoking and always clears local credentials', async () => {
    const clear = vi.fn(async () => undefined);
    const revoke = vi.fn(async () => undefined);
    const logout = new LogoutUseCase(
      { revoke },
      {
        load: async () => sessionCredential,
        save: async () => undefined,
        clear,
      },
      { requireAccessToken: async () => 'fresh-access' },
    );

    const result = await logout.execute();

    expect(revoke).toHaveBeenCalledWith('fresh-access');
    expect(clear).toHaveBeenCalledOnce();
    expect(result.data).toMatchObject({ local_cleared: true, remote_revoked: true });
  });

  it('revokes an OTP refresh family even when legacy credentials omit sessionId', async () => {
    const clear = vi.fn(async () => undefined);
    const revoke = vi.fn(async () => undefined);
    const logout = new LogoutUseCase(
      { revoke },
      {
        load: async () => {
          return {
            ...sessionCredential,
            sessionId: undefined,
          };
        },
        save: async () => undefined,
        clear,
      },
      { requireAccessToken: async () => 'fresh-access' },
    );

    await expect(logout.execute()).resolves.toMatchObject({
      data: { local_cleared: true, remote_revoked: true },
    });
    expect(revoke).toHaveBeenCalledWith('fresh-access');
    expect(clear).toHaveBeenCalledOnce();
  });

  it('clears local credentials when refresh cannot reach the server', async () => {
    const clear = vi.fn(async () => undefined);
    const logout = new LogoutUseCase(
      { revoke: vi.fn(async () => undefined) },
      {
        load: async () => sessionCredential,
        save: async () => undefined,
        clear,
      },
      {
        requireAccessToken: async () => {
          throw new AkError('offline', {
            code: 'network_error',
            exitCode: EXIT_CODES.dependency,
          });
        },
      },
    );

    const result = await logout.execute();

    expect(clear).toHaveBeenCalledOnce();
    expect(result.data).toMatchObject({
      local_cleared: true,
      remote_revoked: false,
      remote_revoke_failed: true,
    });
  });

  it('clears corrupt local credentials even when they cannot be loaded', async () => {
    const clear = vi.fn(async () => undefined);
    const logout = new LogoutUseCase(
      { revoke: vi.fn(async () => undefined) },
      {
        load: async () => {
          throw new AkError('corrupt', {
            code: 'security_error',
            exitCode: EXIT_CODES.security,
          });
        },
        save: async () => undefined,
        clear,
      },
      { requireAccessToken: vi.fn(async () => 'unused') },
    );

    const result = await logout.execute();

    expect(clear).toHaveBeenCalledOnce();
    expect(result.data).toMatchObject({
      local_cleared: true,
      remote_revoked: false,
    });
  });

  it('serializes the final clear so a concurrent refresh cannot resurrect credentials', async () => {
    let current: StoredCredential | null = sessionCredential;
    let queue = Promise.resolve();
    const withExclusive = async <T>(action: () => Promise<T>): Promise<T> => {
      const previous = queue;
      let releaseQueue: () => void = () => {};
      queue = new Promise<void>((resolve) => {
        releaseQueue = resolve;
      });
      await previous;
      try {
        return await action();
      } finally {
        releaseQueue();
      }
    };
    let releaseRefresh: () => void = () => {};
    const refreshPaused = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let refreshEntered: () => void = () => {};
    const refreshStarted = new Promise<void>((resolve) => {
      refreshEntered = resolve;
    });
    const store = {
      load: async () => current,
      save: async (value: StoredCredential) => {
        current = value;
      },
      clear: async () => {
        current = null;
      },
      withExclusive,
    };
    const refresh = withExclusive(async () => {
      refreshEntered();
      await refreshPaused;
      await store.save({ ...sessionCredential, accessToken: 'rotated-access' });
    });
    await refreshStarted;
    const logout = new LogoutUseCase(
      { revoke: vi.fn(async () => undefined) },
      store,
      { requireAccessToken: async () => sessionCredential.accessToken },
    );

    const logoutResult = logout.execute();
    releaseRefresh();
    await Promise.all([refresh, logoutResult]);

    expect(current).toBeNull();
  });
});
