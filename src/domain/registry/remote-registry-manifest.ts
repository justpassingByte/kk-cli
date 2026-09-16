import net from 'node:net';
import semver from 'semver';
import { z } from 'zod';
import { KkError, EXIT_CODES } from '../contracts/kk-error.js';

export const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
export const MAX_SIGNED_URL_TTL_MS = 15 * 60 * 1000;

const kitIdSchema = z.string().regex(/^[a-z0-9-]+$/);
const semverSchema = z.string().refine((value) => semver.valid(value) !== null, 'invalid semver');
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const rfc3339Schema = z.string().refine(isRfc3339, 'invalid RFC3339 timestamp');
const dependencySchema = z
  .object({
    kitId: kitIdSchema,
    version: semverSchema,
    sha256: sha256Schema.optional(),
  })
  .strict();
const githubAssetSchema = z
  .object({
    kind: z.enum(['archive', 'manifest', 'sha256']),
    name: z
      .string()
      .min(1)
      .refine(
        (value) =>
          value.trim() !== '' &&
          !value.includes('/') &&
          !value.includes('\\') &&
          !value.includes('..'),
      ),
    sha256: sha256Schema,
    size: z.number().int().safe().positive(),
  })
  .strict();

export const remoteRegistryManifestSchema = z
  .object({
    schemaVersion: z.literal('remote-registry.v1'),
    kitId: kitIdSchema,
    tier: z.enum(['free', 'paid']).optional(),
    runtime: z.enum(['claude-code', 'codex', 'cursor', 'agy', 'antigravity']),
    version: semverSchema,
    channel: z.enum(['dev', 'beta', 'stable']),
    adapterSchemaVersion: z.literal('agentkit-adapter.v1'),
    requiredCliVersion: z.union([z.literal(''), semverSchema]),
    sourceCommit: z.string().regex(/^(?:[a-f0-9]{7,40}|dry-run)$/),
    createdAt: rfc3339Schema,
    artifact: z
      .object({
        url: z.string().refine(isSafeArtifactUrl, 'artifact URL must use HTTPS'),
        sha256: sha256Schema,
        size: z.number().int().safe().positive().max(MAX_ARTIFACT_BYTES),
        signature: z.string().refine((value) => isBase64OfSize(value, 64)),
        signatureAlgorithm: z.literal('ed25519'),
        keyId: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/),
        expiresAt: rfc3339Schema,
      })
      .strict(),
    dependencies: z.array(dependencySchema).max(32).optional(),
    resolvedFrom: z.array(dependencySchema).optional(),
    githubAssets: z.array(githubAssetSchema).max(16).optional(),
  })
  .strict();

export type RemoteRegistryManifest = z.infer<typeof remoteRegistryManifestSchema>;
export type RegistryRuntime = RemoteRegistryManifest['runtime'];
export type RegistryChannel = RemoteRegistryManifest['channel'];

export function parseRemoteRegistryManifest(
  input: unknown,
  now = new Date(),
): RemoteRegistryManifest {
  const result = remoteRegistryManifestSchema.safeParse(input);
  if (!result.success) {
    throw securityError('AgentKit returned an invalid kit manifest.', {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  assertSignedUrlLifetime(result.data, now);
  return result.data;
}

export function assertSignedUrlLifetime(
  manifest: RemoteRegistryManifest,
  now = new Date(),
): void {
  const expiresAt = Date.parse(manifest.artifact.expiresAt);
  const ttl = expiresAt - now.getTime();
  if (ttl <= 0) {
    throw securityError('The verified kit download URL has expired.');
  }
  if (ttl > MAX_SIGNED_URL_TTL_MS) {
    throw securityError('The kit download URL lifetime exceeds the security limit.');
  }
}

export function assertCliCompatibility(
  manifest: RemoteRegistryManifest,
  currentCliVersion: string,
): void {
  const current = currentCliVersion.trim();
  if (!manifest.requiredCliVersion || current === '' || current === 'dev') return;
  if (semver.valid(current) === null) {
    throw new KkError(`Current kk version "${current}" is not valid semver.`, {
      code: 'invalid_input',
      exitCode: EXIT_CODES.invalidInput,
      remediation: 'Install a valid released version of kk.',
    });
  }
  if (!semver.gte(current, manifest.requiredCliVersion)) {
    if (semver.major(current) === 0) {
      return;
    }
    throw new KkError(
      `Kit ${manifest.kitId} requires kk >= ${manifest.requiredCliVersion} (current ${current}).`,
      {
        code: 'unsupported_environment',
        exitCode: EXIT_CODES.dependency,
        remediation: 'Upgrade kk and try again.',
        details: {
          requiredCliVersion: manifest.requiredCliVersion,
          currentCliVersion: current,
        },
      },
    );
  }
}

function isRfc3339(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isSafeArtifactUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (!url.hostname) return false;
    if (url.protocol === 'https:') return true;
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    return (
      url.protocol === 'http:' &&
      (hostname.toLowerCase() === 'localhost' || net.isIP(hostname) > 0) &&
      (hostname.toLowerCase() === 'localhost' || isLoopbackIp(hostname))
    );
  } catch {
    return false;
  }
}

function isLoopbackIp(hostname: string): boolean {
  return hostname === '::1' || hostname.startsWith('127.');
}

function isBase64OfSize(value: string, expectedBytes: number): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return false;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === expectedBytes && decoded.toString('base64') === value;
}

function securityError(message: string, details?: Record<string, unknown>): KkError {
  return new KkError(message, {
    code: 'security_error',
    exitCode: EXIT_CODES.security,
    remediation: 'Do not install this artifact. Retry later or contact AgentKit support.',
    ...(details ? { details } : {}),
  });
}
