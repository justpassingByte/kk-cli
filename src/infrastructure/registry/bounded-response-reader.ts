import { AkError, EXIT_CODES } from '../../domain/contracts/ak-error.js';

export async function readBoundedResponse(
  response: Response,
  maxBytes: number,
  label: string,
): Promise<Buffer> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes) {
      throw limitError(`${label} exceeds the ${maxBytes}-byte limit.`);
    }
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw limitError(`${label} exceeds the ${maxBytes}-byte limit.`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function limitError(message: string): AkError {
  return new AkError(message, {
    code: 'security_error',
    exitCode: EXIT_CODES.security,
    remediation: 'Do not install this artifact. Retry later or contact AgentKit support.',
  });
}
