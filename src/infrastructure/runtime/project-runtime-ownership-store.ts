import fs from 'node:fs/promises';
import path from 'node:path';
import { KkError, EXIT_CODES } from '../../domain/contracts/kk-error.js';
import {
  PROJECT_RUNTIME_OWNERSHIP_RELATIVE_PATH,
  PROJECT_RUNTIME_OWNERSHIP_VERSION,
  type ProjectRuntimeOwnershipV1,
} from '../../domain/runtime/project-runtime-ownership.js';
import { isSha256, sha256Bytes } from '../filesystem/file-hash.js';
import { resolveWithinRoot } from '../filesystem/path-guard.js';

export interface LoadedProjectRuntimeOwnership {
  path: string;
  sha256: string;
  state: ProjectRuntimeOwnershipV1;
}

export async function loadProjectRuntimeOwnership(
  projectRoot: string,
): Promise<LoadedProjectRuntimeOwnership | undefined> {
  const ownershipPath = await resolveWithinRoot(
    projectRoot,
    PROJECT_RUNTIME_OWNERSHIP_RELATIVE_PATH,
  );
  const info = await fs.lstat(ownershipPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!info) return undefined;
  if (!info.isFile() || info.isSymbolicLink()) {
    throw conflict('Project runtime ownership metadata is not a regular file.');
  }
  const contents = await fs.readFile(ownershipPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents.toString('utf8'));
  } catch (error) {
    throw conflict('Project runtime ownership metadata is invalid JSON.', error);
  }
  return {
    path: ownershipPath,
    sha256: sha256Bytes(contents),
    state: parseProjectRuntimeOwnership(parsed, projectRoot),
  };
}

export function serializeProjectRuntimeOwnership(
  state: ProjectRuntimeOwnershipV1,
): string {
  return `${JSON.stringify(parseProjectRuntimeOwnership(state, state.projectDirectory), null, 2)}\n`;
}

function parseProjectRuntimeOwnership(
  value: unknown,
  projectRoot: string,
): ProjectRuntimeOwnershipV1 {
  if (!isRecord(value) || value.version !== PROJECT_RUNTIME_OWNERSHIP_VERSION) {
    throw conflict('Unsupported project runtime ownership schema.');
  }
  const providerSource = value.providerSource;
  if (
    value.runtime !== 'claude-code' ||
    !samePath(value.projectDirectory, projectRoot) ||
    value.marketplaceName !== 'agentkit-local' ||
    !samePath(
      value.marketplacePath,
      path.join(projectRoot, '.claude-plugin', 'marketplace.json'),
    ) ||
    !isSha256(value.marketplaceSha256) ||
    !isRecord(providerSource) ||
    providerSource.kind !== 'directory' ||
    !samePath(providerSource.path, projectRoot) ||
    !isRecord(value.plugins) ||
    typeof value.updatedAt !== 'string'
  ) {
    throw conflict('Project runtime ownership metadata does not match this project.');
  }
  const plugins: ProjectRuntimeOwnershipV1['plugins'] = {};
  for (const [reference, raw] of Object.entries(value.plugins)) {
    if (
      !/^ak-[a-z0-9-]+@agentkit-local$/u.test(reference) ||
      !isRecord(raw) ||
      typeof raw.kitId !== 'string' ||
      typeof raw.version !== 'string' ||
      typeof raw.enabled !== 'boolean'
    ) {
      throw conflict(`Project runtime ownership plugin ${reference} is invalid.`);
    }
    plugins[reference] = {
      kitId: raw.kitId,
      version: raw.version,
      enabled: raw.enabled,
    };
  }
  const residues: ProjectRuntimeOwnershipV1['residues'] = {};
  const rawResidues = value.residues ?? {};
  if (!isRecord(rawResidues)) {
    throw conflict('Project runtime ownership residues are invalid.');
  }
  for (const [reference, raw] of Object.entries(rawResidues)) {
    if (
      !/^ak-[a-z0-9-]+@agentkit-local$/u.test(reference) ||
      !isRecord(raw) ||
      typeof raw.kitId !== 'string' ||
      reference !== `ak-${raw.kitId}@agentkit-local` ||
      typeof raw.version !== 'string' ||
      raw.version.length === 0 ||
      raw.marketplaceEntryName !== `ak-${raw.kitId}` ||
      !isSha256(raw.expectedMarketplaceSha256) ||
      typeof raw.removedAt !== 'string' ||
      raw.removedAt.length === 0 ||
      plugins[reference] !== undefined
    ) {
      throw conflict(`Project runtime ownership residue ${reference} is invalid.`);
    }
    residues[reference] = {
      kitId: raw.kitId,
      version: raw.version,
      marketplaceEntryName: raw.marketplaceEntryName,
      expectedMarketplaceSha256: raw.expectedMarketplaceSha256,
      removedAt: raw.removedAt,
    };
  }
  return {
    version: PROJECT_RUNTIME_OWNERSHIP_VERSION,
    runtime: 'claude-code',
    projectDirectory: projectRoot,
    marketplaceName: 'agentkit-local',
    marketplacePath: path.join(projectRoot, '.claude-plugin', 'marketplace.json'),
    marketplaceSha256: value.marketplaceSha256,
    providerSource: { kind: 'directory', path: projectRoot },
    plugins,
    residues,
    updatedAt: value.updatedAt,
  };
}

function samePath(left: unknown, right: string): boolean {
  if (typeof left !== 'string' || !path.isAbsolute(left)) return false;
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function conflict(message: string, cause?: unknown): KkError {
  return new KkError(message, {
    code: 'conflict',
    exitCode: EXIT_CODES.conflict,
    remediation: 'Run kk doctor and inspect project runtime ownership before retrying.',
    ...(cause ? { cause } : {}),
  });
}
