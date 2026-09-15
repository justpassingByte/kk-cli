import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { AkError, EXIT_CODES } from '../../domain/contracts/ak-error.js';
import type { RuntimeInstall } from './npm-runtime-manager.js';

const HANDOFF_ENV = 'AGENTKIT_RUNTIME_HANDOFF';

interface RuntimeHandoffPayload {
  expectedVersion: string;
  entrypoint: string;
  createdAt: string;
}

export class FreshRuntimeHandoff {
  async launch(install: RuntimeInstall, args: string[]): Promise<void> {
    const payload: RuntimeHandoffPayload = {
      expectedVersion: install.version,
      entrypoint: await realpath(install.entrypoint),
      createdAt: new Date().toISOString(),
    };
    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, [install.entrypoint, ...args], {
        env: {
          ...process.env,
          [HANDOFF_ENV]: JSON.stringify(payload),
        },
        stdio: 'inherit',
        windowsHide: true,
      });
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (signal) reject(new Error(`fresh runtime exited after signal ${signal}`));
        else resolve(code ?? 1);
      });
    }).catch((error) => {
      throw handoffError(error);
    });
    if (exitCode !== 0) throw handoffError(new Error(`fresh runtime exited ${exitCode}`));
  }
}

export async function consumeRuntimeHandoff(
  currentVersion: string,
  argvEntry = process.argv[1],
  now = Date.now(),
): Promise<string | undefined> {
  const raw = process.env[HANDOFF_ENV];
  if (!raw) return undefined;
  delete process.env[HANDOFF_ENV];
  try {
    const payload = JSON.parse(raw) as Partial<RuntimeHandoffPayload>;
    if (
      typeof payload.expectedVersion !== 'string' ||
      typeof payload.entrypoint !== 'string' ||
      typeof payload.createdAt !== 'string' ||
      currentVersion !== payload.expectedVersion ||
      !argvEntry
    ) {
      throw new Error('handoff contract mismatch');
    }
    const createdAt = Date.parse(payload.createdAt);
    if (!Number.isFinite(createdAt) || Math.abs(now - createdAt) > 5 * 60_000) {
      throw new Error('handoff expired');
    }
    const [actualEntrypoint, expectedEntrypoint] = await Promise.all([
      realpath(path.resolve(argvEntry)),
      realpath(payload.entrypoint),
    ]);
    if (normalize(actualEntrypoint) !== normalize(expectedEntrypoint)) {
      throw new Error('handoff entrypoint mismatch');
    }
    return payload.expectedVersion;
  } catch (error) {
    throw handoffError(error);
  }
}

function normalize(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function handoffError(cause: unknown): AkError {
  return new AkError('The updated AgentKit runtime could not take over safely.', {
    code: 'conflict',
    exitCode: EXIT_CODES.conflict,
    remediation: 'Open a new terminal and run ak update again.',
    cause,
  });
}
