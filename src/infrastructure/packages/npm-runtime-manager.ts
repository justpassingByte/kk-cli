import { access, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { KkError, EXIT_CODES } from '../../domain/contracts/kk-error.js';
import { executeNpmCommand } from './npm-command-runner.js';

const packageSchema = z.object({
  name: z.literal('kk-cli'),
  version: z.string().min(1),
  bin: z.union([z.string(), z.record(z.string(), z.string())]),
});

export interface RuntimeInstall {
  packageRoot: string;
  entrypoint: string;
  version: string;
  npmExecutable: string;
}

export type ExecFileLike = (
  executable: string,
  args: string[],
  options?: unknown,
) => Promise<{ stdout: string; stderr?: string }>;

export class NpmRuntimeManager {
  constructor(
    private readonly npmExecutable = 'npm',
    private readonly execute: ExecFileLike = async (_executable, args) =>
      executeNpmCommand(args),
    private readonly currentPackageRoot?: string,
  ) {}

  async inspectGlobalInstall(): Promise<RuntimeInstall> {
    const { stdout } = await this.execute(this.npmExecutable, ['prefix', '--global']);
    const prefix = stdout.trim();
    if (!prefix) throw npmUnavailable();
    const roots =
      process.platform === 'win32'
        ? [path.join(prefix, 'node_modules', 'kk-cli')]
        : [
            path.join(prefix, 'lib', 'node_modules', 'kk-cli'),
            path.join(prefix, 'node_modules', 'kk-cli'),
          ];
    const packageRoot = await firstExisting(roots);
    if (!packageRoot) {
      throw new KkError('The npm-managed KK runtime was not found.', {
        code: 'not_found',
        exitCode: EXIT_CODES.notFound,
        remediation: 'Run npm install --global kk-cli@beta.',
      });
    }
    return this.readInstall(packageRoot);
  }

  async update(channel: 'beta' | 'latest'): Promise<RuntimeInstall> {
    const before = await this.inspectGlobalInstall();
    await this.assertCurrentRuntimeOwner(before.packageRoot);
    const packageName = 'kk-cli';
    const expectedVersion = await this.resolveChannelVersion(channel);
    try {
      await this.execute(this.npmExecutable, [
        'install',
        '--global',
        `${packageName}@${channel}`,
        '--no-audit',
        '--no-fund',
      ]);
    } catch (error) {
      throw new KkError('npm could not update the KK runtime.', {
        code: 'dependency_unavailable',
        exitCode: EXIT_CODES.dependency,
        remediation: `Run ${this.npmExecutable} install --global ${packageName}@${channel}, then retry.`,
        cause: error,
      });
    }
    const installed = await this.inspectGlobalInstall();
    if (installed.version !== expectedVersion) {
      throw new KkError('npm finished, but the requested KK version is not installed.', {
        code: 'conflict',
        exitCode: EXIT_CODES.conflict,
        remediation: `Run ${this.npmExecutable} install --global ${packageName}@${channel}, then run kk doctor.`,
        details: {
          requested_version: expectedVersion,
          installed_version: installed.version,
        },
      });
    }
    return installed;
  }

  async latestVersion(channel: 'beta' | 'latest'): Promise<string> {
    return this.resolveChannelVersion(channel);
  }

  async assertActiveInstall(expectedVersion?: string): Promise<RuntimeInstall> {
    const installed = await this.inspectGlobalInstall();
    await this.assertCurrentRuntimeOwner(installed.packageRoot);
    if (expectedVersion && installed.version !== expectedVersion) {
      throw new KkError('The running kk process is not the freshly installed runtime.', {
        code: 'conflict',
        exitCode: EXIT_CODES.conflict,
        remediation: 'Close this terminal, open a new one, and run kk update again.',
        details: {
          expected_version: expectedVersion,
          running_version: installed.version,
        },
      });
    }
    return installed;
  }

  private async resolveChannelVersion(channel: 'beta' | 'latest'): Promise<string> {
    const packageName = 'kk-cli';
    try {
      const { stdout } = await this.execute(this.npmExecutable, [
        'view',
        `${packageName}@${channel}`,
        'version',
        '--json',
      ]);
      const parsed = JSON.parse(stdout) as unknown;
      if (typeof parsed === 'string' && parsed.trim()) return parsed.trim();
      throw new Error('npm returned no version');
    } catch (error) {
      throw new KkError(`npm could not resolve the KK ${channel} version.`, {
        code: 'dependency_unavailable',
        exitCode: EXIT_CODES.dependency,
        remediation: 'Check npm registry access and try again.',
        cause: error,
      });
    }
  }

  private async assertCurrentRuntimeOwner(globalPackageRoot: string): Promise<void> {
    const currentPackageRoot =
      this.currentPackageRoot || (await findOwningPackageRoot(fileURLToPath(import.meta.url)));
    const [current, global] = await Promise.all([
      realpath(currentPackageRoot).catch(() => currentPackageRoot),
      realpath(globalPackageRoot).catch(() => globalPackageRoot),
    ]);
    if (normalizePath(current) === normalizePath(global)) return;
    throw new KkError('This kk executable is not owned by the active global npm installation.', {
      code: 'conflict',
      exitCode: EXIT_CODES.conflict,
      remediation: 'Run kk doctor and follow its PATH guidance before self-updating.',
      details: { current_package_root: current, npm_package_root: global },
    });
  }

  private async readInstall(packageRoot: string): Promise<RuntimeInstall> {
    const metadata = packageSchema.parse(
      JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8')),
    );
    const bin =
      typeof metadata.bin === 'string'
        ? metadata.bin
        : metadata.bin['kk'];
    if (!bin) throw npmUnavailable();
    const entrypoint = path.resolve(packageRoot, bin);
    await access(entrypoint);
    return {
      packageRoot,
      entrypoint,
      version: metadata.version,
      npmExecutable: this.npmExecutable,
    };
  }
}

async function findOwningPackageRoot(fromFile: string): Promise<string> {
  let directory = path.dirname(fromFile);
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')) as {
        name?: unknown;
      };
      if (metadata.name === 'kk-cli') return directory;
    } catch {
      // Keep walking until the package boundary is found.
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw npmUnavailable();
}

async function firstExisting(candidates: string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    try {
      await access(path.join(candidate, 'package.json'));
      return candidate;
    } catch {
      // Continue to the next platform-compatible npm layout.
    }
  }
  return undefined;
}

function normalizePath(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function npmUnavailable(): KkError {
  return new KkError('The global npm installation could not be inspected safely.', {
    code: 'dependency_unavailable',
    exitCode: EXIT_CODES.dependency,
    remediation: 'Verify npm is on PATH, then run kk doctor.',
  });
}
