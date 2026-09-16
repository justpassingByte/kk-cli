import net from 'node:net';
import semver from 'semver';
import { KkError, EXIT_CODES } from '../../domain/contracts/kk-error.js';
import type { RegistryPublicKeys } from '../../domain/registry/manifest-signature.js';
import { verifyManifestSignature } from '../../domain/registry/manifest-signature.js';
import {
  assertCliCompatibility,
  parseRemoteRegistryManifest,
  type RegistryChannel,
  type RegistryRuntime,
  type RemoteRegistryManifest,
} from '../../domain/registry/remote-registry-manifest.js';
import { readBoundedResponse } from './bounded-response-reader.js';
import { DEFAULT_REGISTRY_PUBLIC_KEYS } from './registry-public-keys.js';

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_ERROR_BYTES = 16 * 1024;

export interface AccessTokenProvider {
  requireAccessToken(): Promise<string>;
  refreshAccessToken?(staleAccessToken?: string): Promise<string>;
}

export interface ResolveKitRequest {
  kitId: string;
  runtime: RegistryRuntime;
  channel?: RegistryChannel;
  version?: string;
}

export interface RemoteRegistryClientOptions {
  baseUrl: string;
  accessTokens: AccessTokenProvider;
  currentCliVersion: string;
  publicKeys?: RegistryPublicKeys;
  request?: typeof fetch;
  now?: () => Date;
}

export class RemoteRegistryClient {
  private readonly baseUrl: URL;
  private readonly request: typeof fetch;
  private readonly publicKeys: RegistryPublicKeys;
  private readonly now: () => Date;

  constructor(private readonly options: RemoteRegistryClientOptions) {
    this.baseUrl = validateRegistryBaseUrl(options.baseUrl);
    this.request = options.request ?? fetch;
    this.publicKeys = options.publicKeys ?? DEFAULT_REGISTRY_PUBLIC_KEYS;
    this.now = options.now ?? (() => new Date());
  }

  async resolve(input: ResolveKitRequest): Promise<RemoteRegistryManifest> {
    const requested = validateRequest(input);
    const accessToken = (await this.options.accessTokens.requireAccessToken()).trim();
    if (!accessToken) {
      throw new KkError('You are not logged in.', {
        code: 'auth_required',
        exitCode: EXIT_CODES.dependency,
        remediation: 'Run kk login.',
      });
    }
    if (looksLikeRawLicenseKey(accessToken)) {
      throw new KkError('A license key cannot be used as a registry session token.', {
        code: 'permission_denied',
        exitCode: EXIT_CODES.security,
        remediation: 'Run kk login to create a device session.',
      });
    }

    const endpoint = new URL(
      `/api/agentkit/kits/${encodeURIComponent(requested.kitId)}/resolve`,
      this.baseUrl,
    );
    endpoint.searchParams.set('runtime', requested.runtime);
    endpoint.searchParams.set('channel', requested.channel);
    if (requested.version) endpoint.searchParams.set('version', requested.version);

    let response = await this.fetchManifest(endpoint, accessToken);
    if (response.status === 401 && this.options.accessTokens.refreshAccessToken) {
      const refreshed = await this.options.accessTokens.refreshAccessToken(accessToken);
      response = await this.fetchManifest(endpoint, refreshed);
    }
    if (!response.ok) throw await decodeRegistryError(response);
    const bytes = await readBoundedResponse(response, MAX_MANIFEST_BYTES, 'Registry manifest');

    let payload: unknown;
    try {
      payload = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      throw new KkError('AgentKit returned malformed registry JSON.', {
        code: 'security_error',
        exitCode: EXIT_CODES.security,
        remediation: 'Retry later or contact AgentKit support.',
        cause: error,
      });
    }
    const manifest = parseRemoteRegistryManifest(payload, this.now());
    verifyManifestSignature(manifest, this.publicKeys);
    assertRequestedIdentity(manifest, requested);
    assertCliCompatibility(manifest, this.options.currentCliVersion);
    return manifest;
  }

  private async fetchManifest(endpoint: URL, accessToken: string): Promise<Response> {
    try {
      return await this.request(endpoint, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'agentkit-manifest-capabilities': 'tier-v1',
        },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new KkError('Could not reach the AgentKit registry.', {
        code: 'network_error',
        exitCode: EXIT_CODES.dependency,
        remediation: 'Check your internet connection and try again.',
        cause: error,
      });
    }
  }
}

function validateRequest(input: ResolveKitRequest): Required<ResolveKitRequest> {
  const kitId = input.kitId.trim();
  const channel = (input.channel ?? 'stable').toLowerCase() as RegistryChannel;
  const version = input.version?.trim() ?? '';
  if (!/^[a-z0-9-]+$/.test(kitId)) throw inputError('Invalid kit ID.');
  if (!['claude-code', 'codex', 'cursor', 'agy', 'antigravity'].includes(input.runtime)) {
    throw inputError('Invalid registry runtime.');
  }
  if (!['dev', 'beta', 'stable'].includes(channel)) throw inputError('Invalid registry channel.');
  if (version && semver.valid(version) === null) {
    throw inputError('Invalid kit version.');
  }
  return { kitId, runtime: input.runtime, channel, version };
}

function assertRequestedIdentity(
  manifest: RemoteRegistryManifest,
  requested: Required<ResolveKitRequest>,
): void {
  const mismatch =
    manifest.kitId !== requested.kitId ||
    manifest.runtime !== requested.runtime ||
    manifest.channel !== requested.channel ||
    (requested.version !== '' && manifest.version !== requested.version);
  if (mismatch) {
    throw new KkError('Registry manifest does not match the requested kit.', {
      code: 'security_error',
      exitCode: EXIT_CODES.security,
      remediation: 'Do not install this artifact. Retry later or contact AgentKit support.',
    });
  }
}

async function decodeRegistryError(response: Response): Promise<KkError> {
  const body = await readBoundedResponse(response, MAX_ERROR_BYTES, 'Registry error response');
  let payload: { code?: unknown; message?: unknown; error?: unknown } = {};
  try {
    payload = JSON.parse(body.toString('utf8')) as typeof payload;
  } catch {
    payload = { error: body.toString('utf8').trim().slice(0, 500) };
  }
  const serverMessage =
    (typeof payload.message === 'string' && payload.message.trim()) ||
    (typeof payload.error === 'string' && payload.error.trim()) ||
    `AgentKit registry returned HTTP ${response.status}.`;
  return new KkError(serverMessage, {
    code: response.status === 401 ? 'auth_expired' : 'dependency_unavailable',
    exitCode: EXIT_CODES.dependency,
    remediation: response.status === 401 ? 'Run kk login again.' : 'Try again later.',
    details: {
      status: response.status,
      ...(typeof payload.code === 'string' ? { registryCode: payload.code } : {}),
    },
  });
}

function looksLikeRawLicenseKey(token: string): boolean {
  return /^(?:ak_license_|license_|lic_)/i.test(token.trim());
}

function inputError(message: string): KkError {
  return new KkError(message, {
    code: 'invalid_input',
    exitCode: EXIT_CODES.invalidInput,
    remediation: 'Check the kit, runtime, channel, and version arguments.',
  });
}

function validateRegistryBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new KkError('AgentKit registry URL is invalid.', {
      code: 'invalid_input',
      exitCode: EXIT_CODES.invalidInput,
      remediation: 'Configure a valid HTTPS AgentKit registry URL.',
      cause: error,
    });
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const loopback =
    hostname.toLowerCase() === 'localhost' ||
    hostname === '::1' ||
    (net.isIP(hostname) === 4 && hostname.startsWith('127.'));
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password) {
    throw inputError('AgentKit registry URL must use HTTPS.');
  }
  return url;
}
