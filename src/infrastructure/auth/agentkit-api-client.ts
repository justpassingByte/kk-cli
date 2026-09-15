import { AkError, EXIT_CODES } from '../../domain/contracts/ak-error.js';
import {
  apiKeyLoginResponseSchema,
  otpLoginResponseSchema,
  refreshResponseSchema,
  type ApiKeyLoginResponse,
  type OtpLoginResponse,
  type RefreshResponse,
} from './auth-types.js';

export class AgentKitApiClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly request: typeof fetch = fetch,
  ) {
    this.baseUrl = validateBaseUrl(baseUrl);
  }

  async startOtp(email: string): Promise<void> {
    await this.post('/api/agentkit/auth/otp/start', { email });
  }

  async verifyOtp(email: string, code: string, deviceId: string): Promise<OtpLoginResponse> {
    return otpLoginResponseSchema.parse(
      await this.post('/api/agentkit/auth/otp/verify', { email, code, deviceId }),
    );
  }

  async loginWithApiKey(apiKey: string): Promise<ApiKeyLoginResponse> {
    return apiKeyLoginResponseSchema.parse(
      await this.post('/api/agentkit/auth/api-key', { apiKey }),
    );
  }

  async refresh(refreshToken: string): Promise<RefreshResponse> {
    return refreshResponseSchema.parse(
      await this.post('/api/agentkit/auth/refresh', { refreshToken }),
    );
  }

  async revoke(accessToken: string): Promise<void> {
    await this.post('/api/agentkit/auth/sessions/current/revoke', {}, accessToken);
  }

  private async post(endpoint: string, body: unknown, bearer?: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.request(new URL(endpoint, this.baseUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new AkError('Could not reach AgentKit.', {
        code: 'network_error',
        exitCode: EXIT_CODES.dependency,
        remediation: 'Check your internet connection and try again.',
        cause: error,
      });
    }

    const payload = await parsePayload(response);
    if (!response.ok) {
      const serverMessage = getServerMessage(payload);
      const serverCode = getServerCode(payload);
      const reauthRequired = getReauthRequired(payload);
      const authFailure =
        response.status === 401 ||
        reauthRequired ||
        serverCode?.startsWith('refresh_') === true;
      throw new AkError(serverMessage || `AgentKit returned HTTP ${response.status}.`, {
        code: authFailure ? 'auth_expired' : 'dependency_unavailable',
        exitCode: EXIT_CODES.dependency,
        remediation:
          response.status === 429
            ? 'Wait for the displayed retry period before requesting another code.'
            : 'Try again. If the problem continues, run ak doctor.',
        details: {
          status: response.status,
          ...(serverCode ? { server_code: serverCode } : {}),
          ...(reauthRequired ? { reauth_required: true } : {}),
        },
      });
    }
    return payload;
  }
}

function validateBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw invalidApiUrl(error);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw invalidApiUrl();
  }
  const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && loopbackHosts.has(url.hostname))
  ) {
    throw invalidApiUrl();
  }
  return url.toString();
}

function invalidApiUrl(cause?: unknown): AkError {
  return new AkError('AgentKit API URL is not secure.', {
    code: 'security_error',
    exitCode: EXIT_CODES.security,
    remediation:
      'Use an HTTPS AgentKit URL. Plain HTTP is allowed only for localhost development.',
    cause,
  });
}

function getServerCode(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const value =
    'errorCode' in payload
      ? payload.errorCode
      : 'code' in payload
        ? payload.code
        : undefined;
  return typeof value === 'string' ? value : undefined;
}

function getReauthRequired(payload: unknown): boolean {
  return Boolean(
    payload &&
      typeof payload === 'object' &&
      'reauthRequired' in payload &&
      payload.reauthRequired === true,
  );
}

async function parsePayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 500) };
  }
}

function getServerMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const value = 'error' in payload ? payload.error : undefined;
  return typeof value === 'string' ? value : undefined;
}
