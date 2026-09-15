import fs from 'node:fs';
import path from 'node:path';
import { Readable, type Readable as ReadableStream } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import tar, { type Headers } from 'tar-stream';
import { AkError, EXIT_CODES } from '../../domain/contracts/ak-error.js';
import { MAX_ARTIFACT_BYTES } from '../../domain/registry/remote-registry-manifest.js';

const MAX_ENTRIES = 10_000;
const MAX_PATH_BYTES = 1 << 20;
const MAX_PATH_LENGTH = 512;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9])(?:\..*)?$/i;

interface ValidatedEntry {
  header: Headers;
  safePath: string;
}

export async function extractVerifiedKitArtifact(
  archive: Uint8Array,
  destination: string,
  kitId: string,
): Promise<void> {
  if (archive.byteLength > MAX_ARTIFACT_BYTES) throw unsafeArchive('Compressed archive is too large.');
  const entries = await validateArchive(archive, kitId);
  if (!entries.some((entry) => entry.safePath === `${kitId}/kit.yaml` && entry.header.type === 'file')) {
    throw unsafeArchive(`Archive is missing ${kitId}/kit.yaml.`);
  }

  await ensureNewDestination(destination);
  try {
    await processArchive(archive, async (header, stream) => {
      const safePath = validateEntryPath(header.name);
      assertKitRoot(safePath, kitId);
      const target = path.join(destination, ...safePath.split('/'));
      if (header.type === 'directory') {
        await fs.promises.mkdir(target, { recursive: true, mode: 0o750 });
        await drain(stream);
        return;
      }
      await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o750 });
      await pipeline(
        stream,
        fs.createWriteStream(target, {
          flags: 'wx',
          mode: header.mode,
        }),
      );
    });
    const kitManifest = await fs.promises.lstat(path.join(destination, kitId, 'kit.yaml'));
    if (!kitManifest.isFile()) throw unsafeArchive(`Archive is missing ${kitId}/kit.yaml.`);
  } catch (error) {
    await fs.promises.rm(destination, { recursive: true, force: true });
    if (error instanceof AkError) throw error;
    throw unsafeArchive('Could not safely extract the kit artifact.', error);
  }
}

async function validateArchive(
  archive: Uint8Array,
  kitId: string,
): Promise<ValidatedEntry[]> {
  const entries: ValidatedEntry[] = [];
  const seen = new Set<string>();
  let totalSize = 0;
  let pathBytes = 0;

  await processArchive(archive, async (header, stream) => {
    if (entries.length >= MAX_ENTRIES) throw unsafeArchive('Archive has too many entries.');
    const safePath = validateEntryPath(header.name);
    assertKitRoot(safePath, kitId);
    const collisionKey = safePath.toLowerCase();
    if (seen.has(collisionKey)) throw unsafeArchive(`Archive contains duplicate path "${safePath}".`);
    seen.add(collisionKey);
    pathBytes += Buffer.byteLength(safePath);
    if (pathBytes > MAX_PATH_BYTES) throw unsafeArchive('Archive path budget exceeded.');
    if (header.type !== 'file' && header.type !== 'directory') {
      throw unsafeArchive(`Archive entry "${safePath}" uses unsupported type "${header.type}".`);
    }
    if (header.type === 'file') {
      validateMode(header.mode, safePath);
      const size = header.size ?? 0;
      if (!Number.isSafeInteger(size) || size < 0) throw unsafeArchive(`Invalid size for "${safePath}".`);
      totalSize += size;
      if (totalSize > MAX_ARTIFACT_BYTES) throw unsafeArchive('Uncompressed archive is too large.');
    }
    entries.push({ header, safePath });
    await drain(stream);
  });
  return entries;
}

function assertKitRoot(safePath: string, kitId: string): void {
  if (safePath !== kitId && !safePath.startsWith(`${kitId}/`)) {
    throw unsafeArchive(
      `Archive entry "${safePath}" is outside the required "${kitId}/" root.`,
    );
  }
}

function validateEntryPath(name: string): string {
  if (!name.trim()) throw unsafeArchive('Archive contains an empty path.');
  if (name.length > MAX_PATH_LENGTH) throw unsafeArchive('Archive entry path is too long.');
  if (name.includes('\\') || name.includes(':') || hasControlCharacter(name)) {
    throw unsafeArchive(`Archive entry path "${name}" is unsafe.`);
  }
  const safePath = path.posix.normalize(name).replace(/\/+$/, '');
  if (
    safePath === '.' ||
    path.posix.isAbsolute(safePath) ||
    safePath === '..' ||
    safePath.startsWith('../')
  ) {
    throw unsafeArchive(`Archive entry path "${name}" escapes its destination.`);
  }
  for (const segment of safePath.split('/')) {
    if (!segment || segment.endsWith('.') || segment.endsWith(' ') || WINDOWS_RESERVED_NAME.test(segment)) {
      throw unsafeArchive(`Archive entry path "${name}" is not cross-platform safe.`);
    }
  }
  return safePath;
}

function validateMode(mode: number | undefined, safePath: string): void {
  if (mode !== 0o644 && mode !== 0o755) {
    throw unsafeArchive(`Archive entry "${safePath}" has unsupported mode ${mode?.toString(8)}.`);
  }
}

async function processArchive(
  archive: Uint8Array,
  onEntry: (header: Headers, stream: ReadableStream) => Promise<void>,
): Promise<void> {
  const extractor = tar.extract();
  extractor.on('entry', (header, stream, next) => {
    void onEntry(header, stream)
      .then(() => next())
      .catch((error: unknown) => extractor.destroy(asError(error)));
  });
  try {
    await pipeline(Readable.from(Buffer.from(archive)), zlib.createGunzip(), extractor);
  } catch (error) {
    if (error instanceof AkError) throw error;
    throw unsafeArchive('Archive is not a valid tar.gz package.', error);
  }
}

async function drain(stream: ReadableStream): Promise<void> {
  for await (const chunk of stream) {
    // Validation consumes every entry so malformed/truncated bodies fail.
    void chunk;
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

async function ensureNewDestination(destination: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(destination), { recursive: true, mode: 0o750 });
  try {
    await fs.promises.mkdir(destination, { mode: 0o750 });
  } catch (error) {
    throw unsafeArchive('Extraction destination must not already exist.', error);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function unsafeArchive(message: string, cause?: unknown): AkError {
  return new AkError(message, {
    code: 'security_error',
    exitCode: EXIT_CODES.security,
    remediation: 'Do not install this artifact. Resolve the kit again or contact AgentKit support.',
    ...(cause ? { cause } : {}),
  });
}
