import { access, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { AkError, EXIT_CODES } from '../../domain/contracts/ak-error.js';
import { executeNpmCommand } from './npm-command-runner.js';

const packageSchema = z.object({
  name: z.literal('@bestagentkits/ak'),
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
        ? [path.join(prefix, 'node_modules', '@bestagentkits', 'ak')]
        : [
            path.join(prefix, 'lib', 'node_modules', '@bestagentkits', 'ak'),
            path.join(prefix, 'node_modules', '@bestagentkits', 'ak'),
          ];
    const packageRoot = await firstExisting(roots);
    if (!packageRoot) {
      throw new AkError('The npm-managed AgentKit runtime was not found.', {
        code: 'not_found',
        exitCode: EXIT_CODES.notFound,
        remediation: 'Run npm install --global @bestagentkits/ak@beta.',
      });
    }
    return this.readInstall(packageRoot);
  }

  async update(channel: 'beta' | 'latest'): Promise<RuntimeInstall> {
    const before = await this.inspectGlobalInstall();
    await this.assertCurrentRuntimeOwner(before.packageRoot);
    const expectedVersion = await this.resolveChannelVersion(channel);
    try {
      await this.execute(this.npmExecutable, [
        'install',
        '--global',
        `@bestagentkits/ak@${channel}`,
        '--no-audit',
        '--no-fund',
      ]);
    } catch (error) {
      throw new AkError('npm could not update the AgentKit runtime.', {
        code: 'dependency_unavailable',
        exitCode: EXIT_CODES.dependency,
        remediation: `Run ${this.npmExecutable} install --global @bestagentkits/ak@${channel}, then retry.`,
        cause: error,
      });
    }
    const installed = await this.inspectGlobalInstall();
    if (installed.version !== expectedVersion) {
      throw new AkError('npm finished, but the requested AgentKit version is not installed.', {
        code: 'conflict',
        exitCode: EXIT_CODES.conflict,
        remediation: `Run ${this.npmExecutable} install --global @bestagentkits/ak@${channel}, then run ak doctor.`,
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
      throw new AkError('The running ak process is not the freshly installed runtime.', {
        code: 'conflict',
        exitCode: EXIT_CODES.conflict,
        remediation: 'Close this terminal, open a new one, and run ak update again.',
        details: {
          expected_version: expectedVersion,
          running_version: installed.version,
        },
      });
    }
    return installed;
  }

  private async resolveChannelVersion(channel: 'beta' | 'latest'): Promise<string> {
    try {
      const { stdout } = await this.execute(this.npmExecutable, [
        'view',
        `@bestagentkits/ak@${channel}`,
        'version',
        '--json',
      ]);
      const parsed = JSON.parse(stdout) as unknown;
      if (typeof parsed === 'string' && parsed.trim()) return parsed.trim();
      throw new Error('npm returned no version');
    } catch (error) {
      throw new AkError(`npm could not resolve the AgentKit ${channel} version.`, {
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
    throw new AkError('This ak executable is not owned by the active global npm installation.', {
      code: 'conflict',
      exitCode: EXIT_CODES.conflict,
      remediation: 'Run ak doctor and follow its PATH guidance before self-updating.',
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
        : metadata.bin['ak'];
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
      if (metadata.name === '@bestagentkits/ak') return directory;
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

function npmUnavailable(): AkError {
  return new AkError('The global npm installation could not be inspected safely.', {
    code: 'dependency_unavailable',
    exitCode: EXIT_CODES.dependency,
    remediation: 'Verify npm is on PATH, then run ak doctor.',
  });
}
