import crypto from 'node:crypto';
import { AkError, EXIT_CODES } from '../contracts/ak-error.js';
import type { RemoteRegistryManifest } from './remote-registry-manifest.js';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const GO_JSON_ESCAPE_PATTERN = /[<>&\u2028\u2029]/g;
const GO_JSON_ESCAPES: Record<string, string> = {
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};

export type RegistryPublicKeys = ReadonlyMap<string, string>;

export function canonicalSignaturePayload(manifest: RemoteRegistryManifest): string {
  return escapeForGoJson(
    JSON.stringify({
      schemaVersion: manifest.schemaVersion,
      kitId: manifest.kitId,
      ...(manifest.tier ? { tier: manifest.tier } : {}),
      runtime: manifest.runtime,
      version: manifest.version,
      channel: manifest.channel,
      adapterSchemaVersion: manifest.adapterSchemaVersion,
      requiredCliVersion: manifest.requiredCliVersion,
      sourceCommit: manifest.sourceCommit,
      createdAt: formatGoTime(manifest.createdAt),
      artifactUrl: manifest.artifact.url,
      artifactSha256: manifest.artifact.sha256,
      artifactSize: manifest.artifact.size,
      artifactExpiresAt: formatGoTime(manifest.artifact.expiresAt),
      ...(manifest.dependencies?.length ? { dependencies: manifest.dependencies } : {}),
      ...(manifest.resolvedFrom?.length ? { resolvedFrom: manifest.resolvedFrom } : {}),
      ...(manifest.githubAssets?.length ? { githubAssets: manifest.githubAssets } : {}),
    }),
  );
}

export function verifyManifestSignature(
  manifest: RemoteRegistryManifest,
  publicKeys: RegistryPublicKeys,
): void {
  const rawPublicKey = publicKeys.get(manifest.artifact.keyId);
  if (!rawPublicKey) {
    throw signatureError(`Unknown AgentKit registry signing key "${manifest.artifact.keyId}".`);
  }
  const publicKeyBytes = decodeBase64Key(rawPublicKey);
  const publicKey = crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, publicKeyBytes]),
    format: 'der',
    type: 'spki',
  });
  const valid = crypto.verify(
    null,
    Buffer.from(canonicalSignaturePayload(manifest)),
    publicKey,
    Buffer.from(manifest.artifact.signature, 'base64'),
  );
  if (!valid) {
    throw signatureError('AgentKit kit manifest signature verification failed.');
  }
}

function decodeBase64Key(value: string): Buffer {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== 32 || bytes.toString('base64') !== value) {
    throw signatureError('AgentKit registry public key is invalid.');
  }
  return bytes;
}

function formatGoTime(value: string): string {
  const match =
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return value;
  const fraction = match[2]?.replace(/0+$/, '');
  const offset = match[3] === '+00:00' || match[3] === '-00:00' ? 'Z' : match[3];
  return `${match[1]}${fraction ? `.${fraction}` : ''}${offset}`;
}

function escapeForGoJson(json: string): string {
  return json.replace(GO_JSON_ESCAPE_PATTERN, (character) => GO_JSON_ESCAPES[character] ?? character);
}

function signatureError(message: string): AkError {
  return new AkError(message, {
    code: 'security_error',
    exitCode: EXIT_CODES.security,
    remediation: 'Do not install this artifact. Retry later or contact AgentKit support.',
  });
}
