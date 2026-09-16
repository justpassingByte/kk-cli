import fs from 'node:fs/promises';
import path from 'node:path';
import { KkError, EXIT_CODES } from '../../domain/contracts/kk-error.js';
import type { InstallManifestEntry } from '../../domain/kits/install-manifest.js';
import { assertPortableRelativePath } from '../filesystem/path-guard.js';
import { sha256Bytes } from '../filesystem/file-hash.js';

const MAX_FILES = 10_000;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const RESERVED_MANIFEST = '.kk/install-manifest.json';

export interface StagedKitFile {
  relativePath: string;
  contents: Buffer;
  mode: number;
  sha256: string;
}

export async function collectStagedKitFiles(
  extractedRoot: string,
  kitId: string,
): Promise<StagedKitFile[]> {
  const kitRoot = path.join(extractedRoot, kitId);
  const files: StagedKitFile[] = [];
  let totalBytes = 0;

  async function walk(directory: string, relativeDirectory = ''): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isSymbolicLink()) throw unsafe(`Staged kit contains a symbolic link: ${entry.name}`);
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      assertPortableRelativePath(relativePath);
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) throw unsafe(`Staged kit contains an unsupported entry: ${relativePath}`);
      if (relativePath === RESERVED_MANIFEST) {
        throw unsafe('Remote kit artifact cannot provide local ownership metadata.');
      }
      if (files.length >= MAX_FILES) throw unsafe('Staged kit contains too many files.');
      const contents = await fs.readFile(absolutePath);
      totalBytes += contents.byteLength;
      if (totalBytes > MAX_TOTAL_BYTES) throw unsafe('Staged kit exceeds the 64 MiB file budget.');
      const stat = await fs.stat(absolutePath);
      files.push({
        relativePath,
        contents,
        mode: stat.mode & 0o111 ? 0o755 : 0o644,
        sha256: sha256Bytes(contents),
      });
    }
  }

  await walk(kitRoot);
  if (!files.some((file) => file.relativePath === 'kit.yaml')) {
    throw unsafe(`Staged kit is missing ${kitId}/kit.yaml.`);
  }
  return files;
}

export function toManifestEntries(files: StagedKitFile[]): InstallManifestEntry[] {
  return files.map((file) => ({
    rel_path: file.relativePath,
    sha256: file.sha256,
  }));
}

function unsafe(message: string): KkError {
  return new KkError(message, {
    code: 'security_error',
    exitCode: EXIT_CODES.security,
    remediation: 'Do not install this artifact. Resolve it again or contact AgentKit support.',
  });
}
