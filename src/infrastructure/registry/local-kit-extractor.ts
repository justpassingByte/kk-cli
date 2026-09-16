import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import tar from 'tar-stream';
import { KkError, EXIT_CODES } from '../../domain/contracts/kk-error.js';

const execFileAsync = promisify(execFile);

export interface LocalKitExtractionResult {
  kitId: string;
  version: string;
}

export async function extractLocalKit(
  sourcePath: string,
  destination: string,
  preferredKitId = 'engineer',
): Promise<LocalKitExtractionResult> {
  const resolvedSource = path.resolve(sourcePath);
  let stat;
  try {
    stat = await fs.stat(resolvedSource);
  } catch (error) {
    throw new KkError(`Source path "${resolvedSource}" does not exist.`, {
      code: 'invalid_input',
      exitCode: EXIT_CODES.invalidInput,
      remediation: 'Provide a valid path to a kit .zip, .tar.gz, or directory using --from <path>.',
      cause: error,
    });
  }

  await fs.mkdir(destination, { recursive: true, mode: 0o755 });

  if (stat.isDirectory()) {
    await fs.cp(resolvedSource, destination, { recursive: true });
  } else {
    const ext = path.extname(resolvedSource).toLowerCase();
    if (ext === '.zip') {
      await extractZipFile(resolvedSource, destination);
    } else if (ext === '.gz' || ext === '.tgz' || ext === '.tar') {
      await extractTarGzFile(resolvedSource, destination);
    } else {
      // Try zip first, then tar
      try {
        await extractZipFile(resolvedSource, destination);
      } catch {
        await extractTarGzFile(resolvedSource, destination);
      }
    }
  }

  // Normalize directory structure
  return await normalizeExtractedKitStructure(destination, preferredKitId);
}

async function extractZipFile(zipPath: string, destination: string): Promise<void> {
  if (process.platform === 'win32') {
    const script = `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destination.replace(/'/g, "''")}' -Force`;
    try {
      await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        timeout: 60_000,
      });
      return;
    } catch (error) {
      throw new KkError('Failed to extract zip file on Windows.', {
        code: 'security_error',
        exitCode: EXIT_CODES.security,
        remediation: 'Ensure the zip file is valid and not corrupted.',
        cause: error,
      });
    }
  }

  // Unix / macOS
  try {
    await execFileAsync('unzip', ['-q', '-o', zipPath, '-d', destination], {
      timeout: 60_000,
    });
  } catch (error) {
    throw new KkError('Failed to extract zip file with unzip command.', {
      code: 'security_error',
      exitCode: EXIT_CODES.security,
      remediation: 'Ensure unzip is installed and the zip file is valid.',
      cause: error,
    });
  }
}

async function extractTarGzFile(tarPath: string, destination: string): Promise<void> {
  const fileBuffer = await fs.readFile(tarPath);
  let decompressed: Buffer;
  try {
    decompressed = zlib.gunzipSync(fileBuffer);
  } catch {
    decompressed = fileBuffer; // Might be uncompressed .tar
  }

  await new Promise<void>((resolve, reject) => {
    const extract = tar.extract();
    extract.on('entry', async (header, stream, next) => {
      try {
        const entryPath = path.join(destination, header.name);
        if (header.type === 'directory') {
          await fs.mkdir(entryPath, { recursive: true });
          stream.resume();
          next();
        } else {
          await fs.mkdir(path.dirname(entryPath), { recursive: true });
          const chunks: Buffer[] = [];
          stream.on('data', (c) => chunks.push(c));
          stream.on('end', async () => {
            await fs.writeFile(entryPath, Buffer.concat(chunks), { mode: header.mode ?? 0o644 });
            next();
          });
        }
      } catch (err) {
        reject(err);
      }
    });
    extract.on('finish', () => resolve());
    extract.on('error', (err) => reject(err));
    extract.end(decompressed);
  });
}

async function normalizeExtractedKitStructure(
  destination: string,
  preferredKitId: string,
): Promise<LocalKitExtractionResult> {
  const entries = await fs.readdir(destination, { withFileTypes: true });

  let kitId = preferredKitId;
  let targetKitDir = path.join(destination, kitId);

  // Check if there is already a subfolder matching preferredKitId
  const exactMatch = entries.find((e) => e.isDirectory() && e.name === preferredKitId);
  if (exactMatch) {
    targetKitDir = path.join(destination, exactMatch.name);
    kitId = exactMatch.name;
  } else {
    // Check if there is a single directory inside
    const subdirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));
    if (subdirs.length === 1 && !entries.some((e) => e.isFile() && e.name === 'kit.yaml')) {
      const singleDir = subdirs[0]!;
      kitId = singleDir.name.replace(/^ak-/, '');
      targetKitDir = path.join(destination, singleDir.name);
      // If singleDir name is not kitId, rename or keep
      if (singleDir.name !== kitId) {
        const renamedDir = path.join(destination, kitId);
        await fs.rename(targetKitDir, renamedDir);
        targetKitDir = renamedDir;
      }
    } else {
      // The extracted files are directly in destination, move them into destination/<kitId>
      const tempDir = path.join(destination, '__temp_staging__');
      await fs.mkdir(tempDir, { recursive: true });
      for (const entry of entries) {
        if (entry.name === '__temp_staging__') continue;
        await fs.rename(path.join(destination, entry.name), path.join(tempDir, entry.name));
      }
      await fs.rename(tempDir, targetKitDir);
    }
  }

  // Detect or establish kit version
  let version = '1.0.0';
  const kitYamlPath = path.join(targetKitDir, 'kit.yaml');
  try {
    const content = await fs.readFile(kitYamlPath, 'utf8');
    const versionMatch = content.match(/version:\s*["']?([^"'\s\r\n]+)["']?/i);
    if (versionMatch?.[1]) version = versionMatch[1];
    const nameMatch = content.match(/name:\s*["']?([^"'\s\r\n]+)["']?/i);
    if (nameMatch?.[1]) kitId = nameMatch[1].replace(/^ak-/, '');
  } catch {
    // Create kit.yaml if missing
    await fs.writeFile(
      kitYamlPath,
      `schemaVersion: 1\nname: ${kitId}\nversion: ${version}\ndescription: Offline local kit\n`,
      'utf8',
    );
  }

  // Ensure .claude-plugin/plugin.json exists for Claude Code projection
  const pluginDir = path.join(targetKitDir, '.claude-plugin');
  await fs.mkdir(pluginDir, { recursive: true });
  const pluginJsonPath = path.join(pluginDir, 'plugin.json');
  try {
    await fs.access(pluginJsonPath);
  } catch {
    await fs.writeFile(
      pluginJsonPath,
      JSON.stringify(
        {
          name: `ak-${kitId}`,
          version: version,
          description: `AgentKit ${kitId} plugin`,
        },
        null,
        2,
      ),
      'utf8',
    );
  }

  return { kitId, version };
}
