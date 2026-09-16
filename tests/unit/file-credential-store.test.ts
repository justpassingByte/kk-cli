import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileCredentialStore } from '../../src/infrastructure/credentials/file-credential-store.js';
import type { StoredCredential } from '../../src/infrastructure/credentials/credential-types.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('FileCredentialStore', () => {
  it(
    'atomically saves and reloads a private credential',
    async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kk-credential-test-'));
      temporaryDirectories.push(directory);
      const credentialPath = path.join(directory, 'credentials.json');
      const store = new FileCredentialStore(credentialPath);
      const credential: StoredCredential = {
        schemaVersion: 1,
        authMethod: 'email_otp',
        accessToken: 'access-value',
        refreshToken: 'refresh-value',
        user: { id: 'user-1', email: 'user@example.com' },
        deviceId: 'device-1',
      };

      await store.save(credential);

      expect(await store.load()).toEqual(credential);
      await expect(
        fs.lstat(path.join(directory, '.credentials.json.kk-next')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(
        fs.lstat(path.join(directory, '.credentials.json.kk-previous')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      if (process.platform !== 'win32') {
        expect((await fs.stat(credentialPath)).mode & 0o077).toBe(0);
      }
    },
    30_000,
  );

  it('clear is idempotent', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kk-credential-test-'));
    temporaryDirectories.push(directory);
    const store = new FileCredentialStore(path.join(directory, 'missing.json'));
    await store.clear();
    await store.clear();
    expect(await store.load()).toBeNull();
  });

  it(
    'promotes a synced next credential after an interrupted replacement',
    async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kk-credential-test-'));
      temporaryDirectories.push(directory);
      const credentialPath = path.join(directory, 'credentials.json');
      const oldCredential = credential('old-access');
      const rotatedCredential = credential('rotated-access');
      const store = new FileCredentialStore(credentialPath);
      await store.save(oldCredential);
      await writePrivateJson(
        path.join(directory, '.credentials.json.kk-next'),
        rotatedCredential,
      );

      await expect(store.load()).resolves.toEqual(rotatedCredential);
      await expect(
        fs.lstat(path.join(directory, '.credentials.json.kk-next')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    },
    30_000,
  );

  it(
    'restores the previous credential if displacement finished before replacement',
    async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kk-credential-test-'));
      temporaryDirectories.push(directory);
      const credentialPath = path.join(directory, 'credentials.json');
      const oldCredential = credential('old-access');
      const previousPath = path.join(
        directory,
        '.credentials.json.kk-previous',
      );
      const store = new FileCredentialStore(credentialPath);
      await store.save(oldCredential);
      await fs.rename(credentialPath, previousPath);

      await expect(store.load()).resolves.toEqual(oldCredential);
      await expect(
        fs.lstat(path.join(directory, '.credentials.json.kk-previous')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    },
    30_000,
  );
});

function credential(accessToken: string): StoredCredential {
  return {
    schemaVersion: 1,
    authMethod: 'email_otp',
    accessToken,
    refreshToken: 'refresh-value',
    user: { id: 'user-1', email: 'user@example.com' },
    deviceId: 'device-1',
  };
}

async function writePrivateJson(
  target: string,
  value: StoredCredential,
): Promise<void> {
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  if (process.platform !== 'win32') await fs.chmod(target, 0o600);
}
