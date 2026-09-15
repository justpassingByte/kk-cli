import crypto, { type KeyObject } from 'node:crypto';
import {
  canonicalSignaturePayload,
  type RegistryPublicKeys,
} from '../../../src/domain/registry/manifest-signature.js';
import type { RemoteRegistryManifest } from '../../../src/domain/registry/remote-registry-manifest.js';

export interface SigningFixture {
  manifest: RemoteRegistryManifest;
  publicKeys: RegistryPublicKeys;
}

export function createManifest(
  overrides: Partial<RemoteRegistryManifest> = {},
): RemoteRegistryManifest {
  return {
    schemaVersion: 'remote-registry.v1',
    kitId: 'engineer',
    tier: 'paid',
    runtime: 'codex',
    version: '1.2.3',
    channel: 'stable',
    adapterSchemaVersion: 'agentkit-adapter.v1',
    requiredCliVersion: '0.1.0',
    sourceCommit: 'abcdef1',
    createdAt: '2026-07-28T06:00:00Z',
    artifact: {
      url: 'https://r2.example.test/engineer.tar.gz?part=1&signature=test',
      sha256: 'a'.repeat(64),
      size: 1024,
      signature: Buffer.alloc(64).toString('base64'),
      signatureAlgorithm: 'ed25519',
      keyId: 'test-key',
      expiresAt: '2026-07-28T06:10:00Z',
    },
    dependencies: [{ kitId: 'core', version: '1.2.3', sha256: 'b'.repeat(64) }],
    ...overrides,
  };
}

export function signManifest(
  manifest: RemoteRegistryManifest,
  privateKey?: KeyObject,
): SigningFixture {
  const pair = privateKey
    ? { privateKey, publicKey: crypto.createPublicKey(privateKey) }
    : crypto.generateKeyPairSync('ed25519');
  const signature = crypto
    .sign(null, Buffer.from(canonicalSignaturePayload(manifest)), pair.privateKey)
    .toString('base64');
  const signed = {
    ...manifest,
    artifact: {
      ...manifest.artifact,
      signature,
    },
  };
  const spki = pair.publicKey.export({ format: 'der', type: 'spki' });
  return {
    manifest: signed,
    publicKeys: new Map([[signed.artifact.keyId, spki.subarray(-32).toString('base64')]]),
  };
}
