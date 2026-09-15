import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface NpmInvocation {
  executable: string;
  argsPrefix: string[];
}

export async function executeNpmCommand(
  args: string[],
  options: { timeout?: number; maxBuffer?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  const invocation = await resolveNpmInvocation();
  return execFileAsync(
    invocation.executable,
    [...invocation.argsPrefix, ...args],
    {
      timeout: options.timeout ?? 120_000,
      maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
      windowsHide: true,
    },
  );
}

export async function resolveNpmInvocation(
  platform: NodeJS.Platform = process.platform,
  nodeExecutable = process.execPath,
  searchPath = '',
): Promise<NpmInvocation> {
  if (platform !== 'win32') {
    return { executable: 'npm', argsPrefix: [] };
  }

  const nodeDirectory = path.dirname(nodeExecutable);
  const pathDirectories = searchPath.split(path.delimiter).filter(Boolean);
  const candidates = [
    path.join(nodeDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ...pathDirectories.map((directory) =>
      path.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return { executable: nodeExecutable, argsPrefix: [candidate] };
    } catch {
      // Continue through known npm layouts without invoking a command shim.
    }
  }
  throw new Error('npm-cli.js was not found beside the active Node.js runtime.');
}
