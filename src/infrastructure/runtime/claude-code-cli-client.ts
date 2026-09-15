import { spawn } from 'node:child_process';
import { AkError, EXIT_CODES } from '../../domain/contracts/ak-error.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

export interface ClaudeCommandOptions {
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface ClaudeCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ClaudeProcessRunner = (
  executable: string,
  argv: string[],
  options: ClaudeCommandOptions,
) => Promise<ClaudeCommandResult>;

export interface ClaudeProviderState {
  pluginInstalled: boolean;
  pluginEnabled: boolean;
  pluginVersion?: string;
  marketplaceKnown: boolean;
  marketplaceConflict: boolean;
  marketplaceHasOtherPlugins: boolean;
  marketplaceOtherPlugins: Array<{
    reference: string;
    enabled: boolean;
    version?: string;
  }>;
}

export class ClaudeCodeCliClient {
  constructor(private readonly runner: ClaudeProcessRunner = runClaudeProcess) {}

  async assertSupported(cwd: string): Promise<void> {
    await this.requireSuccess(['--version'], cwd, 15_000, 'Claude Code is unavailable.');
    const pluginHelp = await this.requireSuccess(
      ['plugin', 'list', '--help'],
      cwd,
      15_000,
      'This Claude Code version does not support plugins.',
    );
    const marketplaceHelp = await this.requireSuccess(
      ['plugin', 'marketplace', 'list', '--help'],
      cwd,
      15_000,
      'This Claude Code version does not support project marketplaces.',
    );
    if (!`${pluginHelp.stdout}\n${pluginHelp.stderr}`.includes('--json')) {
      throw unsupported('Claude Code is outdated: plugin list --json is required.');
    }
    if (!`${marketplaceHelp.stdout}\n${marketplaceHelp.stderr}`.includes('--json')) {
      throw unsupported('Claude Code is outdated: marketplace list --json is required.');
    }
  }

  async captureProviderState(cwd: string, pluginReference: string): Promise<ClaudeProviderState> {
    const plugins = await this.requireJson(
      ['plugin', 'list', '--json'],
      cwd,
      'Could not inspect Claude Code plugins.',
    );
    const marketplaces = await this.requireJson(
      ['plugin', 'marketplace', 'list', '--json'],
      cwd,
      'Could not inspect Claude Code marketplaces.',
    );
    const plugin = findObject(plugins, (entry) => {
      const reference = stringField(entry, 'ref', 'id', 'reference', 'plugin');
      const scope = stringField(entry, 'scope');
      const projectPath = stringField(entry, 'projectPath', 'project');
      const errors = entry.errors;
      return (
        reference === pluginReference &&
        scope === 'project' &&
        (projectPath === undefined || samePath(projectPath, cwd)) &&
        (!Array.isArray(errors) || errors.length === 0)
      );
    });
    const exactMarketplace = findObject(
      marketplaces,
      (entry) =>
        stringField(entry, 'name', 'id', 'marketplace') === 'agentkit-local' &&
        stringField(entry, 'source') === 'directory' &&
        samePath(stringField(entry, 'path') ?? '', cwd),
    );
    const conflictingMarketplace = findObject(
      marketplaces,
      (entry) =>
        stringField(entry, 'name', 'id', 'marketplace') === 'agentkit-local' &&
        entry !== exactMarketplace,
    );
    const pluginVersion = plugin && stringField(plugin, 'version');
    const marketplaceOtherPlugins = findObjects(plugins, (entry) => {
      const reference = stringField(entry, 'ref', 'id', 'reference', 'plugin');
      const scope = stringField(entry, 'scope');
      const projectPath = stringField(entry, 'projectPath', 'project');
      return (
        reference !== undefined &&
        reference !== pluginReference &&
        reference.endsWith('@agentkit-local') &&
        scope === 'project' &&
        booleanField(entry, 'installed', true) &&
        (projectPath === undefined || samePath(projectPath, cwd))
      );
    })
      .map((entry) => {
        const reference = stringField(
          entry,
          'ref',
          'id',
          'reference',
          'plugin',
        ) as string;
        const version = stringField(entry, 'version');
        return {
          reference,
          enabled: booleanField(entry, 'enabled', false),
          ...(version ? { version } : {}),
        };
      })
      .sort((left, right) => left.reference.localeCompare(right.reference));
    return {
      pluginInstalled: plugin !== undefined && booleanField(plugin, 'installed', true),
      pluginEnabled: plugin !== undefined && booleanField(plugin, 'enabled', false),
      ...(pluginVersion ? { pluginVersion } : {}),
      marketplaceKnown: exactMarketplace !== undefined,
      marketplaceConflict: conflictingMarketplace !== undefined,
      marketplaceHasOtherPlugins: marketplaceOtherPlugins.length > 0,
      marketplaceOtherPlugins,
    };
  }

  async addMarketplace(cwd: string): Promise<void> {
    await this.requireSuccess(
      ['plugin', 'marketplace', 'add', cwd, '--scope', 'project'],
      cwd,
      DEFAULT_TIMEOUT_MS,
      'Claude Code could not register the AgentKit marketplace.',
    );
  }

  async installPlugin(cwd: string, pluginReference: string): Promise<void> {
    await this.requireSuccess(
      ['plugin', 'install', pluginReference, '--scope', 'project'],
      cwd,
      DEFAULT_TIMEOUT_MS,
      `Claude Code could not install ${pluginReference}.`,
    );
  }

  async updatePlugin(cwd: string, pluginReference: string): Promise<void> {
    await this.requireSuccess(
      ['plugin', 'update', pluginReference, '--scope', 'project'],
      cwd,
      DEFAULT_TIMEOUT_MS,
      `Claude Code could not update ${pluginReference}.`,
    );
  }

  async updateMarketplace(cwd: string): Promise<void> {
    await this.requireSuccess(
      ['plugin', 'marketplace', 'update', 'agentkit-local'],
      cwd,
      DEFAULT_TIMEOUT_MS,
      'Claude Code could not refresh the AgentKit marketplace.',
    );
  }

  async uninstallPlugin(cwd: string, pluginReference: string): Promise<void> {
    await this.requireSuccess(
      ['plugin', 'uninstall', pluginReference, '--scope', 'project'],
      cwd,
      DEFAULT_TIMEOUT_MS,
      `Claude Code could not compensate ${pluginReference}.`,
    );
  }

  async disablePlugin(cwd: string, pluginReference: string): Promise<void> {
    await this.requireSuccess(
      ['plugin', 'disable', pluginReference, '--scope', 'project'],
      cwd,
      DEFAULT_TIMEOUT_MS,
      `Claude Code could not disable ${pluginReference}.`,
    );
  }

  async enablePlugin(cwd: string, pluginReference: string): Promise<void> {
    await this.requireSuccess(
      ['plugin', 'enable', pluginReference, '--scope', 'project'],
      cwd,
      DEFAULT_TIMEOUT_MS,
      `Claude Code could not enable ${pluginReference}.`,
    );
  }

  async removeMarketplace(cwd: string): Promise<void> {
    await this.requireSuccess(
      ['plugin', 'marketplace', 'remove', 'agentkit-local'],
      cwd,
      DEFAULT_TIMEOUT_MS,
      'Claude Code could not compensate the AgentKit marketplace.',
    );
  }

  private async requireJson(argv: string[], cwd: string, message: string): Promise<unknown> {
    const result = await this.requireSuccess(argv, cwd, 15_000, message);
    try {
      return JSON.parse(result.stdout) as unknown;
    } catch (error) {
      throw runtimeFailure(`${message} Claude Code returned invalid JSON.`, error);
    }
  }

  private async requireSuccess(
    argv: string[],
    cwd: string,
    timeoutMs: number,
    message: string,
  ): Promise<ClaudeCommandResult> {
    let result: ClaudeCommandResult;
    try {
      result = await this.runner('claude', argv, {
        cwd,
        timeoutMs,
        maxOutputBytes: MAX_OUTPUT_BYTES,
      });
    } catch (error) {
      throw unsupported(`${message} Install or upgrade Claude Code and try again.`, error);
    }
    if (result.exitCode !== 0) {
      throw runtimeFailure(`${message} ${redact(result.stderr || result.stdout)}`);
    }
    return result;
  }
}

export const runClaudeProcess: ClaudeProcessRunner = async (executable, argv, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, argv, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`Claude Code timed out after ${options.timeoutMs}ms.`));
    }, options.timeoutMs);
    const collect = (bucket: Buffer[], chunk: Buffer): void => {
      if (settled) return;
      outputBytes += chunk.byteLength;
      if (outputBytes > options.maxOutputBytes) {
        settled = true;
        clearTimeout(timer);
        child.kill();
        reject(new Error('Claude Code output exceeded the safety limit.'));
        return;
      }
      bucket.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: code ?? 1,
        stdout: redact(Buffer.concat(stdout).toString('utf8')),
        stderr: redact(Buffer.concat(stderr).toString('utf8')),
      });
    });
  });

function findObject(
  value: unknown,
  predicate: (entry: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = findObject(item, predicate);
      if (match) return match;
    }
    return undefined;
  }
  if (!isObject(value)) return undefined;
  if (predicate(value)) return value;
  for (const child of Object.values(value)) {
    const match = findObject(child, predicate);
    if (match) return match;
  }
  return undefined;
}

function findObjects(
  value: unknown,
  predicate: (entry: Record<string, unknown>) => boolean,
): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => findObjects(item, predicate));
  }
  if (!isObject(value)) return [];
  return [
    ...(predicate(value) ? [value] : []),
    ...Object.values(value).flatMap((child) => findObjects(child, predicate)),
  ];
}

function stringField(entry: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    if (typeof entry[name] === 'string') return entry[name];
  }
  return undefined;
}

function booleanField(
  entry: Record<string, unknown>,
  name: string,
  defaultValue: boolean,
): boolean {
  return typeof entry[name] === 'boolean' ? entry[name] : defaultValue;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = value.replaceAll('\\', '/').replace(/\/+$/u, '');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function redact(value: string): string {
  return value
    .slice(0, MAX_OUTPUT_BYTES)
    .replace(/\b(?:sk|ak|api|token)[_-][A-Za-z0-9._-]{8,}\b/giu, '[REDACTED]')
    .replace(/\bBearer\s+\S+/giu, 'Bearer [REDACTED]')
    .trim();
}

function unsupported(message: string, cause?: unknown): AkError {
  return new AkError(message, {
    code: 'unsupported_environment',
    exitCode: EXIT_CODES.dependency,
    remediation: 'Install the current Claude Code release and ensure `claude` is on PATH.',
    ...(cause ? { cause } : {}),
  });
}

function runtimeFailure(message: string, cause?: unknown): AkError {
  return new AkError(message.trim(), {
    code: 'runtime_error',
    exitCode: EXIT_CODES.runtime,
    remediation: 'Run `claude plugin list --json` in this project, fix the reported issue, then retry.',
    ...(cause ? { cause } : {}),
  });
}
