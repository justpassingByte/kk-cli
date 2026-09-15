import { describe, expect, it } from 'vitest';
import { DoctorUseCase } from '../../src/application/doctor-use-case.js';
import type { StoredCredential } from '../../src/infrastructure/credentials/credential-types.js';

const paths = {
  home: '/missing-agentkit-home',
  credentials: '/missing-agentkit-home/credentials.json',
  installedKits: '/missing-agentkit-home/installed-kits.json',
  locks: '/missing-agentkit-home/locks',
  snapshots: '/missing-agentkit-home/snapshots',
  recovery: '/missing-agentkit-home/recovery',
  supportReports: '/missing-agentkit-home/support-reports',
};

describe('DoctorUseCase', () => {
  it('reports competing ak executables without changing PATH', async () => {
    const credential: StoredCredential = {
      schemaVersion: 1,
      authMethod: 'api_key',
      accessToken: 'secret',
      user: { id: 'user', email: 'person@example.test' },
      deviceId: 'device',
    };
    const doctor = new DoctorUseCase({
      paths,
      credentialStore: {
        load: async () => credential,
        save: async () => undefined,
        clear: async () => undefined,
      },
      discoverExecutables: async () => [
        {
          path: '/npm/bin/ak',
          realPath: '/npm/lib/node_modules/@bestagentkits/ak/bin/ak.js',
          kind: 'npm',
          packageVersion: '0.1.0-beta.0',
        },
        {
          path: '/usr/local/bin/ak',
          realPath: '/usr/local/bin/ak',
          kind: 'legacy_native_candidate',
        },
      ],
    });

    const result = await doctor.execute();

    expect(result.kind).toBe('doctor.report');
    expect(result.data).toMatchObject({
      state: 'warnings',
      summary: { fail: 0 },
    });
    const checks = result.data['checks'] as Array<{ id: string; status: string }>;
    expect(checks).toContainEqual(
      expect.objectContaining({ id: 'ak_path', status: 'warn' }),
    );
  });

  it('warns when the access token is expired but a refresh session is valid', async () => {
    const doctor = new DoctorUseCase({
      paths,
      now: () => new Date('2026-07-28T10:00:00.000Z'),
      credentialStore: credentialStore({
        schemaVersion: 1,
        authMethod: 'email_otp',
        accessToken: 'expired',
        accessTokenExpiresAt: '2026-07-28T09:59:00.000Z',
        refreshToken: 'refresh',
        refreshTokenExpiresAt: '2026-08-28T10:00:00.000Z',
        user: { id: 'user', email: 'person@example.test' },
      }),
      discoverExecutables: async () => [],
    });

    const result = await doctor.execute();
    const checks = result.data['checks'] as Array<{ id: string; status: string }>;

    expect(checks).toContainEqual(
      expect.objectContaining({ id: 'login', status: 'warn' }),
    );
  });

  it('fails login health when the refresh session has expired', async () => {
    const doctor = new DoctorUseCase({
      paths,
      now: () => new Date('2026-07-28T10:00:00.000Z'),
      credentialStore: credentialStore({
        schemaVersion: 1,
        authMethod: 'email_otp',
        accessToken: 'token',
        accessTokenExpiresAt: '2026-07-28T11:00:00.000Z',
        refreshToken: 'refresh',
        refreshTokenExpiresAt: '2026-07-28T09:00:00.000Z',
        user: { id: 'user', email: 'person@example.test' },
      }),
      discoverExecutables: async () => [],
    });

    const result = await doctor.execute();
    const checks = result.data['checks'] as Array<{ id: string; status: string }>;

    expect(checks).toContainEqual(
      expect.objectContaining({ id: 'login', status: 'fail' }),
    );
  });

  it('isolates an unexpected check failure and completes the remaining report', async () => {
    const doctor = new DoctorUseCase({
      paths,
      credentialStore: credentialStore(null),
      discoverExecutables: async () => {
        throw new Error('unexpected discovery failure');
      },
    });

    const result = await doctor.execute();
    const checks = result.data['checks'] as Array<{ id: string; status: string }>;

    expect(checks).toHaveLength(7);
    expect(checks).toContainEqual(
      expect.objectContaining({ id: 'ak_path', status: 'fail' }),
    );
  });

  it('fails visibly when an interrupted transaction is still pending', async () => {
    const doctor = new DoctorUseCase({
      paths,
      credentialStore: credentialStore(null),
      discoverExecutables: async () => [],
      inspectTransactions: async () => ({
        pending: 1,
        committed: 0,
        rolledBack: 0,
        invalid: 0,
      }),
    });

    const result = await doctor.execute();
    const checks = result.data['checks'] as Array<{
      id: string;
      status: string;
      summary: string;
    }>;

    expect(checks).toContainEqual(
      expect.objectContaining({
        id: 'recovery',
        status: 'fail',
        summary: expect.stringMatching(/1 interrupted/i),
      }),
    );
  });
});

function credentialStore(credential: StoredCredential | null) {
  return {
    load: async () => credential,
    save: async () => undefined,
    clear: async () => undefined,
  };
}
