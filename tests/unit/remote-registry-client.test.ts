import { describe, expect, it, vi } from 'vitest';
import { RemoteRegistryClient } from '../../src/infrastructure/registry/remote-registry-client.js';
import { createManifest, signManifest } from '../fixtures/registry/manifest-fixture.js';

describe('RemoteRegistryClient', () => {
  it('authenticates the resolve GET and verifies the requested manifest identity', async () => {
    const fixture = signManifest(createManifest());
    const request = vi.fn<typeof fetch>(async () =>
      Promise.resolve(
        new Response(JSON.stringify(fixture.manifest), {
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const accessTokens = { requireAccessToken: vi.fn(async () => 'device-session-token') };
    const client = new RemoteRegistryClient({
      baseUrl: 'https://agentkit.example.test',
      accessTokens,
      currentCliVersion: '1.0.0',
      publicKeys: fixture.publicKeys,
      request,
      now: () => new Date('2026-07-28T06:05:00Z'),
    });

    const manifest = await client.resolve({
      kitId: 'engineer',
      runtime: 'codex',
      channel: 'stable',
      version: '1.2.3',
    });

    expect(manifest.kitId).toBe('engineer');
    expect(accessTokens.requireAccessToken).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0]!;
    expect(String(url)).toBe(
      'https://agentkit.example.test/api/agentkit/kits/engineer/resolve?runtime=codex&channel=stable&version=1.2.3',
    );
    expect(init).toMatchObject({
      method: 'GET',
      headers: {
        authorization: 'Bearer device-session-token',
        'agentkit-manifest-capabilities': 'tier-v1',
      },
    });
  });

  it('rejects a raw license key before making a request', async () => {
    const request = vi.fn<typeof fetch>();
    const client = new RemoteRegistryClient({
      baseUrl: 'https://agentkit.example.test',
      accessTokens: { requireAccessToken: async () => 'ak_license_raw' },
      currentCliVersion: '1.0.0',
      request,
    });

    await expect(
      client.resolve({ kitId: 'engineer', runtime: 'codex', channel: 'stable' }),
    ).rejects.toThrow(/license key/i);
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects a signed response for a different requested runtime', async () => {
    const fixture = signManifest(createManifest({ runtime: 'claude-code' }));
    const client = new RemoteRegistryClient({
      baseUrl: 'https://agentkit.example.test',
      accessTokens: { requireAccessToken: async () => 'session-token' },
      currentCliVersion: '1.0.0',
      publicKeys: fixture.publicKeys,
      request: async () => new Response(JSON.stringify(fixture.manifest)),
      now: () => new Date('2026-07-28T06:05:00Z'),
    });

    await expect(
      client.resolve({ kitId: 'engineer', runtime: 'codex', channel: 'stable' }),
    ).rejects.toThrow(/does not match/i);
  });

  it('refreshes once after a 401 and retries the registry request exactly once', async () => {
    const fixture = signManifest(createManifest());
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(fixture.manifest)));
    const accessTokens = {
      requireAccessToken: vi.fn(async () => 'stale-access'),
      refreshAccessToken: vi.fn(async () => 'fresh-access'),
    };
    const client = new RemoteRegistryClient({
      baseUrl: 'https://agentkit.example.test',
      accessTokens,
      currentCliVersion: '1.0.0',
      publicKeys: fixture.publicKeys,
      request,
      now: () => new Date('2026-07-28T06:05:00Z'),
    });

    await client.resolve({
      kitId: 'engineer',
      runtime: 'codex',
      channel: 'stable',
      version: '1.2.3',
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(accessTokens.refreshAccessToken).toHaveBeenCalledWith('stale-access');
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      headers: { authorization: 'Bearer fresh-access' },
    });
  });

  it('does not retry a second 401', async () => {
    const request = vi.fn<typeof fetch>(async () => new Response('{}', { status: 401 }));
    const refreshAccessToken = vi.fn(async () => 'fresh-access');
    const client = new RemoteRegistryClient({
      baseUrl: 'https://agentkit.example.test',
      accessTokens: {
        requireAccessToken: async () => 'stale-access',
        refreshAccessToken,
      },
      currentCliVersion: '1.0.0',
      request,
    });

    await expect(
      client.resolve({ kitId: 'engineer', runtime: 'codex', channel: 'stable' }),
    ).rejects.toMatchObject({ code: 'auth_expired' });
    expect(request).toHaveBeenCalledTimes(2);
    expect(refreshAccessToken).toHaveBeenCalledOnce();
  });
});
