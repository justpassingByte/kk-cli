import fs from 'node:fs/promises';
import path from 'node:path';
import type { DiagnosticCheck } from '../../domain/diagnostics/diagnostic-check.js';
import type {
  InstalledKitRecord,
  ProjectRuntimeRegistryRecord,
} from '../../domain/kits/installed-kit-registry.js';
import type { InstalledKitStore } from '../installed-kits/installed-kit-store.js';
import { sha256Bytes } from '../filesystem/file-hash.js';
import type {
  ClaudeCodeCliClient,
  ClaudeProviderState,
} from './claude-code-cli-client.js';
import { loadProjectRuntimeOwnership } from './project-runtime-ownership-store.js';

type ProviderInspector = Pick<ClaudeCodeCliClient, 'captureProviderState'>;

export async function checkClaudeProjectRuntimes(
  store: InstalledKitStore,
  provider: ProviderInspector,
): Promise<DiagnosticCheck> {
  const registry = await store.load();
  const projects = Object.values(registry.projects ?? {});
  const projectKits = Object.values(registry.kits).filter(
    (record) => record.runtime === 'claude-code' && record.scope === 'project',
  );
  if (projects.length === 0 && projectKits.length === 0) {
    return {
      id: 'project_plugins',
      status: 'ok',
      summary: 'No managed Claude Code project plugin runtime is recorded.',
    };
  }
  if (
    projectKits.some(
      (record) =>
        !projects.some((project) =>
          samePath(project.projectDirectory, record.projectDirectory as string),
        ),
    )
  ) {
    return failure('A managed project kit has no matching project runtime record.');
  }

  let plugins = 0;
  let residues = 0;
  for (const project of projects) {
    const result = await checkProject(
      project,
      projectKits.filter(
        (record) =>
          record.projectDirectory !== undefined &&
          samePath(record.projectDirectory, project.projectDirectory),
      ),
      provider,
    );
    if (result.failure) return failure(result.failure);
    plugins += result.plugins;
    residues += result.residues;
  }

  if (residues > 0) {
    return {
      id: 'project_plugins',
      status: 'warn',
      summary: `${residues} preserved project marketplace residue(s) need review.`,
      remediation:
        'Review the modified marketplace file before installing or updating another kit.',
      details: { projects: projects.length, plugins, residues },
    };
  }
  return {
    id: 'project_plugins',
    status: 'ok',
    summary: `${plugins} managed Claude Code project plugin(s) are active.`,
    details: { projects: projects.length, plugins, residues: 0 },
  };
}

async function checkProject(
  project: ProjectRuntimeRegistryRecord,
  records: InstalledKitRecord[],
  provider: ProviderInspector,
): Promise<{ plugins: number; residues: number; failure?: string }> {
  const loaded = await loadProjectRuntimeOwnership(project.projectDirectory);
  if (
    !loaded ||
    !samePath(loaded.path, project.ownershipPath) ||
    loaded.sha256 !== project.ownershipSha256
  ) {
    return failed('Project runtime ownership and global registry do not agree.');
  }
  const active = Object.entries(loaded.state.plugins);
  const residueEntries = Object.entries(loaded.state.residues);
  const recordsByReference = new Map(
    records.map((record) => [`ak-${record.kit}@agentkit-local`, record]),
  );
  for (const [reference, expected] of active) {
    const record = recordsByReference.get(reference);
    if (
      !record ||
      record.kit !== expected.kitId ||
      record.kitVersion !== expected.version ||
      !samePath(record.installRoot, path.join(project.projectDirectory, `ak-${record.kit}`))
    ) {
      return failed(`Global kit registry does not match active plugin ${reference}.`);
    }
    const actual = await provider.captureProviderState(
      project.projectDirectory,
      reference,
    );
    if (!providerMatches(actual, expected.version, expected.enabled)) {
      return failed(`Claude Code provider state does not match ${reference}.`);
    }
  }
  for (const reference of recordsByReference.keys()) {
    if (loaded.state.plugins[reference] === undefined) {
      return failed(`Project ownership is missing active plugin ${reference}.`);
    }
  }
  for (const [reference] of residueEntries) {
    if (recordsByReference.has(reference)) {
      return failed(`Residue ${reference} still has an active global kit record.`);
    }
    const actual = await provider.captureProviderState(
      project.projectDirectory,
      reference,
    );
    if (actual.marketplaceConflict || actual.pluginInstalled) {
      return failed(`Claude Code still reports residue ${reference} as installed.`);
    }
  }
  const marketplace = await fs
    .readFile(loaded.state.marketplacePath)
    .catch(() => undefined);
  const marketplaceClean =
    marketplace !== undefined &&
    sha256Bytes(marketplace) === loaded.state.marketplaceSha256;
  if (!marketplaceClean && residueEntries.length === 0) {
    return failed('A managed project marketplace changed outside AgentKit.');
  }
  if (active.length === 0 && residueEntries.length === 0) {
    const emptyState = await provider.captureProviderState(
      project.projectDirectory,
      'ak-agentkit-doctor-probe@agentkit-local',
    );
    if (emptyState.marketplaceConflict || emptyState.marketplaceKnown) {
      return failed('Claude Code still reports an empty AgentKit marketplace.');
    }
  }
  return { plugins: active.length, residues: residueEntries.length };
}

function failed(message: string): { plugins: 0; residues: 0; failure: string } {
  return { plugins: 0, residues: 0, failure: message };
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function providerMatches(
  actual: ClaudeProviderState,
  version: string,
  enabled: boolean,
): boolean {
  return (
    !actual.marketplaceConflict &&
    actual.marketplaceKnown &&
    actual.pluginInstalled &&
    actual.pluginEnabled === enabled &&
    actual.pluginVersion === version
  );
}

function failure(summary: string): DiagnosticCheck {
  return {
    id: 'project_plugins',
    status: 'fail',
    summary,
    remediation:
      'Run `claude plugin list --json` in the project, then retry or prepare a scrubbed support report.',
  };
}
