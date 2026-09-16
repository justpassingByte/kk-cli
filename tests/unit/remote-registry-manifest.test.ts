import { describe, expect, it } from 'vitest';
import {
  canonicalSignaturePayload,
  verifyManifestSignature,
} from '../../src/domain/registry/manifest-signature.js';
import {
  assertCliCompatibility,
  parseRemoteRegistryManifest,
} from '../../src/domain/registry/remote-registry-manifest.js';
import { createManifest, signManifest } from '../fixtures/registry/manifest-fixture.js';

const NOW = new Date('2026-07-28T06:05:00Z');

describe('remote registry manifest', () => {
  it('matches the backend canonical JSON and verifies Ed25519 signatures', () => {
    const fixture = signManifest(createManifest());

    expect(canonicalSignaturePayload(fixture.manifest)).toBe(
      `{"schemaVersion":"remote-registry.v1","kitId":"engineer","tier":"paid","runtime":"codex","version":"1.2.3","channel":"stable","adapterSchemaVersion":"agentkit-adapter.v1","requiredCliVersion":"0.1.0","sourceCommit":"abcdef1","createdAt":"2026-07-28T06:00:00Z","artifactUrl":"https://r2.example.test/engineer.tar.gz?part=1\\u0026signature=test","artifactSha256":"${'a'.repeat(64)}","artifactSize":1024,"artifactExpiresAt":"2026-07-28T06:10:00Z","dependencies":[{"kitId":"core","version":"1.2.3","sha256":"${'b'.repeat(64)}"}]}`,
    );
    expect(() => verifyManifestSignature(fixture.manifest, fixture.publicKeys)).not.toThrow();
  });

  it('formats RFC3339 offsets and fractional seconds like Go encoding/json', () => {
    const manifest = createManifest({
      createdAt: '2026-07-28T13:00:00.120000+07:00',
      artifact: {
        ...createManifest().artifact,
        expiresAt: '2026-07-28T06:10:00.000+00:00',
      },
    });

    expect(canonicalSignaturePayload(manifest)).toContain(
      '"createdAt":"2026-07-28T13:00:00.12+07:00"',
    );
    expect(canonicalSignaturePayload(manifest)).toContain(
      '"artifactExpiresAt":"2026-07-28T06:10:00Z"',
    );
  });

  it('rejects unknown fields and invalid signed URL lifetimes', () => {
    expect(() =>
      parseRemoteRegistryManifest({ ...createManifest(), unexpected: true }, NOW),
    ).toThrow(/invalid kit manifest/i);
    expect(() =>
      parseRemoteRegistryManifest(
        createManifest({
          artifact: {
            ...createManifest().artifact,
            expiresAt: '2026-07-28T06:21:00Z',
          },
        }),
        NOW,
      ),
    ).toThrow(/lifetime/i);
    expect(() =>
      parseRemoteRegistryManifest(
        createManifest({
          artifact: {
            ...createManifest().artifact,
            expiresAt: '2026-07-28T06:04:59Z',
          },
        }),
        NOW,
      ),
    ).toThrow(/expired/i);
  });

  it('enforces released CLI semver requirements while allowing dev builds', () => {
    const manifest = parseRemoteRegistryManifest(
      createManifest({ requiredCliVersion: '2.0.0' }),
      NOW,
    );
    expect(() => assertCliCompatibility(manifest, '1.9.9')).toThrow(/requires kk/i);
    expect(() => assertCliCompatibility(manifest, 'not-semver')).toThrow(/not valid semver/i);
    expect(() => assertCliCompatibility(manifest, 'dev')).not.toThrow();
    expect(() => assertCliCompatibility(manifest, '2.0.0')).not.toThrow();
  });

  it('detects signed metadata tampering', () => {
    const fixture = signManifest(createManifest());
    const tampered = {
      ...fixture.manifest,
      artifact: {
        ...fixture.manifest.artifact,
        size: fixture.manifest.artifact.size + 1,
      },
    };
    expect(() => verifyManifestSignature(tampered, fixture.publicKeys)).toThrow(
      /signature verification failed/i,
    );
  });
});
