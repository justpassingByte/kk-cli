import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';

export function sha256Bytes(contents: Uint8Array | string): string {
  return createHash('sha256').update(contents).digest('hex');
}

export async function sha256File(filePath: string): Promise<string> {
  const contents = await fs.readFile(filePath);
  return sha256Bytes(contents);
}

export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}
