import { describe, expect, it, vi } from 'vitest';
import { AgentKitApiClient } from '../../src/infrastructure/auth/agentkit-api-client.js';

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

describe('AgentKitApiClient', () => {
  it('accepts the backend legacy license placeholder on both login methods', async () => {
    const responses = [
      {
        token: 'otp-access',
        authMethod: 'email_otp',
        licenseId: '',
        user: { id: 'u1', email: 'user@example.com' },
        refreshToken: 'refresh',
        refreshTokenExpiresAt: '2026-08-27T10:00:00.000Z',
      },
      {
        token: 'api-access',
        authMethod: 'api_key',
        licenseId: '',
        user: { id: 'u1', email: 'user@example.com' },
      },
    ];
    const request = vi.fn(async () =>
      new Response(JSON.stringify(responses.shift()), { status: 200 }),
    );
    const client = new AgentKitApiClient('https://agentkit.example.test', request);

    await expect(
      client.verifyOtp('user@example.com', '123456', 'device-1'),
    ).resolves.toMatchObject({ licenseId: '' });
    await expect(client.loginWithApiKey('api-key')).resolves.toMatchObject({
      licenseId: '',
    });
  });

  it('accepts the backend refresh token-pair envelope without repeated user data', async () => {
    const request = vi.fn(async () =>
      new Response(
        JSON.stringify({
          schemaVersion: 1,
          token: 'new-access',
          accessToken: 'new-access',
          refreshToken: 'new-refresh',
          accessTokenExpiresAt: '2026-07-28T10:15:00.000Z',
          refreshTokenExpiresAt: '2026-08-27T10:00:00.000Z',
          sessionId: 'session-1',
          deviceId: 'device-1',
        }),
        { status: 200 },
      ),
    );
    const client = new AgentKitApiClient('https://agentkit.example.test', request);

    await expect(client.refresh('old-refresh')).resolves.toMatchObject({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      sessionId: 'session-1',
    });
  });

  it('rejects refresh-family fields on an API-key login response', async () => {
    const request = vi.fn(async () =>
      new Response(
        JSON.stringify({
          token: 'access',
          authMethod: 'api_key',
          user: { id: 'u1', email: 'user@example.com' },
          refreshToken: 'must-not-be-accepted',
        }),
        { status: 200 },
      ),
    );
    const client = new AgentKitApiClient('https://agentkit.example.test', request);

    await expect(client.loginWithApiKey('api-key')).rejects.toBeDefined();
  });

  it('rejects insecure or credential-bearing API URLs', () => {
    expect(() => new AgentKitApiClient('http://agentkit.example.test')).toThrow(
      'AgentKit API URL is not secure.',
    );
    expect(
      () => new AgentKitApiClient('https://user:secret@agentkit.example.test'),
    ).toThrow('AgentKit API URL is not secure.');
    expect(() => new AgentKitApiClient('http://localhost:8787')).not.toThrow();
    expect(() => new AgentKitApiClient('http://127.0.0.1:8787')).not.toThrow();
  });

  it('revokes the current device session with the bearer access token', async () => {
    const request = vi.fn(
      async (input: FetchInput, init?: FetchInit) => {
        void input;
        void init;
        return new Response('{}', { status: 200 });
      },
    );
    const client = new AgentKitApiClient('https://agentkit.example.test', request);

    await client.revoke('fresh-access');

    expect(request).toHaveBeenCalledOnce();
    const [url, options] = request.mock.calls[0]!;
    expect(String(url)).toBe(
      'https://agentkit.example.test/api/agentkit/auth/sessions/current/revoke',
    );
    expect(options).toMatchObject({
      method: 'POST',
      headers: {
        authorization: 'Bearer fresh-access',
        'content-type': 'application/json',
      },
    });
  });

  it('preserves stable backend error codes without leaking response bodies', async () => {
    const request = vi.fn(
      async (input: FetchInput, init?: FetchInit) => {
        void input;
        void init;
        return new Response(JSON.stringify({ error: 'Session expired.', code: 'refresh_expired' }), {
          status: 401,
        });
      },
    );
    const client = new AgentKitApiClient('https://agentkit.example.test', request);

    await expect(client.refresh('expired-refresh')).rejects.toMatchObject({
      code: 'auth_expired',
      details: { status: 401, server_code: 'refresh_expired' },
    });
  });

  it('parses additive errorCode and reauthRequired fields', async () => {
    const request = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: 'This session was revoked.',
          errorCode: 'session_revoked',
          reauthRequired: true,
        }),
        { status: 403 },
      ),
    );
    const client = new AgentKitApiClient('https://agentkit.example.test', request);

    await expect(client.refresh('revoked-refresh')).rejects.toMatchObject({
      code: 'auth_expired',
      details: {
        status: 403,
        server_code: 'session_revoked',
        reauth_required: true,
      },
    });
  });
});
