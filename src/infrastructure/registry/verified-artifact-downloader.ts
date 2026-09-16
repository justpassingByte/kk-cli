import crypto from 'node:crypto';
import { KkError, EXIT_CODES } from '../../domain/contracts/kk-error.js';
import {
  assertSignedUrlLifetime,
  MAX_ARTIFACT_BYTES,
  type RemoteRegistryManifest,
} from '../../domain/registry/remote-registry-manifest.js';
import { readBoundedResponse } from './bounded-response-reader.js';

export interface ArtifactDownloadOptions {
  request?: typeof fetch;
  now?: Date;
}

export async function downloadVerifiedArtifact(
  manifest: RemoteRegistryManifest,
  options: ArtifactDownloadOptions = {},
): Promise<Buffer> {
  assertSignedUrlLifetime(manifest, options.now ?? new Date());
  if (manifest.artifact.size > MAX_ARTIFACT_BYTES) {
    throw artifactError('Kit artifact exceeds the 64 MiB download limit.');
  }

  let response: Response;
  try {
    response = await (options.request ?? fetch)(manifest.artifact.url, {
      method: 'GET',
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    throw new KkError('Could not download the verified kit artifact.', {
      code: 'network_error',
      exitCode: EXIT_CODES.dependency,
      remediation: 'Check your internet connection and try again.',
      cause: error,
    });
  }
  if (!response.ok) {
    throw new KkError(`Kit artifact download returned HTTP ${response.status}.`, {
      code: 'dependency_unavailable',
      exitCode: EXIT_CODES.dependency,
      remediation: 'Resolve the kit again to obtain a fresh download URL.',
      details: { status: response.status },
    });
  }
  const contentLength = response.headers.get('content-length');
  if (contentLength && Number(contentLength) !== manifest.artifact.size) {
    throw artifactError('Kit artifact Content-Length does not match its signed size.');
  }
  const bytes = await readBoundedResponse(response, MAX_ARTIFACT_BYTES, 'Kit artifact');
  if (bytes.length !== manifest.artifact.size) {
    throw artifactError('Kit artifact size does not match its signed manifest.');
  }
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  if (digest !== manifest.artifact.sha256) {
    throw artifactError('Kit artifact SHA-256 does not match its signed manifest.');
  }
  return bytes;
}

function artifactError(message: string): KkError {
  return new KkError(message, {
    code: 'security_error',
    exitCode: EXIT_CODES.security,
    remediation: 'Do not install this artifact. Resolve the kit again or contact AgentKit support.',
  });
}
