import fs from 'node:fs/promises';
import path from 'node:path';
import { KkError, EXIT_CODES } from '../domain/contracts/kk-error.js';
import type { CommandResult } from '../domain/contracts/command-result.js';
import type { InstalledKitRecord } from '../domain/kits/installed-kit-registry.js';
import type { OwnershipStatus } from '../domain/lifecycle/filesystem-transaction.js';
import type {
  PreparedRuntimeUnprojection,
  RuntimeProjector,
} from '../domain/runtime/runtime-projector.js';
import type { LocalFilesystemTransaction } from '../infrastructure/filesystem/local-filesystem-transaction.js';
import { sha256Bytes, sha256File } from '../infrastructure/filesystem/file-hash.js';
import { canonicalizeRoot } from '../infrastructure/filesystem/path-guard.js';
import {
  createInstallManifest,
  serializeInstallManifest,
  serializeRegistry,
  type InstalledKitStore,
} from '../infrastructure/installed-kits/installed-kit-store.js';
import { classifyInstalledPath } from '../infrastructure/installed-kits/ownership-classifier.js';
import type { KkPaths } from '../infrastructure/paths/kk-paths.js';
import type { PromptService } from '../presentation/prompt-service.js';

export interface UninstallInput {
  installationId?: string;
  kitId?: string;
  runtime?: InstalledKitRecord['runtime'];
  scope?: InstalledKitRecord['scope'];
  projectDirectory?: string;
  yes: boolean;
  noInteractive: boolean;
}

interface UninstallPreview {
  owned_clean: string[];
  owned_modified: string[];
  foreign: string[];
  missing: string[];
  manifest_status: OwnershipStatus;
}

const NPM_GUIDANCE = 'The kk npm runtime was not removed. Remove it separately with: npm uninstall -g kk-cli';

export class UninstallUseCase {
  constructor(
    private readonly paths: KkPaths,
    private readonly store: InstalledKitStore,
    private readonly transaction: LocalFilesystemTransaction,
    private readonly prompts: PromptService,
    private readonly isInteractive: () => boolean = () => Boolean(process.stdin.isTTY),
    private readonly projector?: RuntimeProjector,
  ) {}

  async execute(input: UninstallInput): Promise<CommandResult> {
    await this.transaction.recover(this.paths.snapshots, this.paths.recovery);
    const registry = await this.store.load();
    const record = await resolveInstallation(input, Object.values(registry.kits));
    const target = await resolveTarget(record, this.paths, this.projector);
    const preview = await buildPreview(record, target.root, target.prefix, target.manifestRelativePath);
    await this.confirm(input, record, preview);

    let nextRegistry = this.store.prepareRemove(record.installationId, registry);
    if (target.runtimeUnprojection) {
      const ownership = target.runtimeUnprojection.projectOwnership;
      const currentProject = registry.projects?.[ownership.projectId];
      if (
        !currentProject ||
        currentProject.projectDirectory !== target.root ||
        path.resolve(currentProject.ownershipPath) !== path.resolve(ownership.path) ||
        currentProject.ownershipSha256 !== ownership.previousSha256
      ) {
        throw conflict(
          'Global registry and project runtime ownership metadata do not agree.',
        );
      }
      nextRegistry = this.store.prepareUpsertProject(
        {
          ...currentProject,
          ownershipSha256: ownership.nextSha256,
          updatedAt: new Date().toISOString(),
        },
        nextRegistry,
      );
    }
    const registryHash = await sha256File(this.paths.installedKits);
    const transaction = await this.transaction.run({
      roots: target.root === target.registryRoot ? [target.root] : [target.root, target.registryRoot],
      snapshotDirectory: this.paths.snapshots,
      recoveryDirectory: this.paths.recovery,
      writes: target.runtimeUnprojection?.writes ?? [],
      ...(target.runtimeUnprojection
        ? { metadataWrites: target.runtimeUnprojection.metadataWrites }
        : {}),
      staleFiles: record.files.map((entry) => ({
        root: target.root,
        entry: { rel_path: `${target.prefix}/${entry.rel_path}`, sha256: entry.sha256 },
      })),
      ...(preview.manifest_status === 'owned-clean'
        ? {
            manifestDelete: {
              root: target.root,
              entry: {
                rel_path: target.manifestRelativePath,
                sha256: expectedManifestHash(record),
              },
            },
          }
        : {}),
      registryCommit: {
        root: target.registryRoot,
        relativePath: path.basename(this.paths.installedKits),
        contents: serializeRegistry(nextRegistry),
        expectedPreviousSha256: registryHash,
      },
      ...(target.runtimeUnprojection
        ? { externalStep: target.runtimeUnprojection.externalStep }
        : {}),
      hooks: {
        revalidate: async () => {
          if (serializeRegistry(await this.store.load()) !== serializeRegistry(registry)) {
            throw conflict('Installed-kit registry changed while preparing uninstall.');
          }
        },
      },
    });
    const outcome = transactionOutcome(record, target.prefix, transaction.classifications, preview.manifest_status);
    const cleanupStarts = record.files.map((entry) =>
      entry.rel_path,
    ).map((relativePath) =>
      path.dirname(path.join(record.installRoot, ...relativePath.split('/'))),
    );
    cleanupStarts.push(path.dirname(record.manifestPath));
    const cleanup = await removeEmptyDirectories(cleanupStarts, target.root);

    return {
      kind: 'kit.uninstall',
      data: {
        installation_id: record.installationId,
        kit: record.kit,
        runtime: record.runtime,
        scope: record.scope,
        preview,
        outcome,
        deleted_files: outcome.owned_clean,
        preserved_files: [...outcome.owned_modified, ...outcome.foreign, ...outcome.missing].sort(),
        manifest_deleted: preview.manifest_status === 'owned-clean',
        registry_removed: true,
        cleanup_removed_directories: cleanup,
        transaction_id: transaction.transactionId,
        snapshot_path: transaction.snapshotPath,
        npm_runtime_removed: false,
        npm_runtime_guidance: NPM_GUIDANCE,
        shared_config_residue:
          target.runtimeUnprojection?.sharedConfigResidue ?? false,
      },
      message: `Uninstalled ${record.kit} from ${record.runtime}; preserved ${outcome.owned_modified.length + outcome.foreign.length} changed or foreign file(s).`,
      humanLines: [
        ...(outcome.owned_modified.length ? [`Modified files preserved: ${outcome.owned_modified.join(', ')}`] : []),
        ...(outcome.foreign.length ? [`Foreign paths preserved: ${outcome.foreign.join(', ')}`] : []),
        ...(target.runtimeUnprojection?.sharedConfigResidue
          ? [
              'The modified project marketplace was preserved. Run kk doctor before another kit lifecycle operation.',
            ]
          : []),
        NPM_GUIDANCE,
      ],
    };
  }

  private async confirm(input: UninstallInput, record: InstalledKitRecord, preview: UninstallPreview): Promise<void> {
    if (input.yes) return;
    const summary = `${preview.owned_clean.length} owned file(s) will be deleted; ${preview.owned_modified.length + preview.foreign.length} changed or foreign file(s) will be preserved`;
    if (!input.noInteractive && this.isInteractive()) {
      if (await this.prompts.confirm(`Uninstall ${record.kit} (${record.runtime}, ${record.scope})? ${summary}.`, false)) return;
      throw cancelled('Nothing changed.', preview);
    }
    throw cancelled(`Uninstall needs confirmation. Review the preview, then rerun with --installation-id ${record.installationId} --yes.`, preview);
  }
}

function transactionOutcome(
  record: InstalledKitRecord,
  prefix: string,
  classifications: Array<{ relativePath: string; status: OwnershipStatus }>,
  manifestStatus: OwnershipStatus,
): UninstallPreview {
  const byPath = new Map(classifications.map((item) => [item.relativePath, item.status]));
  const groups: Record<OwnershipStatus, string[]> = {
    'owned-clean': [],
    'owned-modified': [],
    foreign: [],
    missing: [],
  };
  for (const entry of [...record.files].sort((left, right) => left.rel_path.localeCompare(right.rel_path))) {
    const status = byPath.get(`${prefix}/${entry.rel_path}`);
    if (!status) throw conflict(`Transaction did not classify ${entry.rel_path}.`);
    groups[status].push(entry.rel_path);
  }
  return {
    owned_clean: groups['owned-clean'],
    owned_modified: groups['owned-modified'],
    foreign: groups.foreign,
    missing: groups.missing,
    manifest_status: manifestStatus,
  };
}

async function resolveInstallation(input: UninstallInput, records: InstalledKitRecord[]): Promise<InstalledKitRecord> {
  if (input.installationId) {
    const exact = records.find((record) => record.installationId === input.installationId);
    if (!exact) throw notFound(`Installed kit ${input.installationId} was not found.`);
    return exact;
  }
  if (!input.kitId) throw invalidInput('Provide --installation-id or a kit name.');
  let matches = records.filter((record) => record.kit === input.kitId);
  if (input.runtime) matches = matches.filter((record) => record.runtime === input.runtime);
  if (input.scope) matches = matches.filter((record) => record.scope === input.scope);
  if (input.projectDirectory) {
    const project = await fs.realpath(path.resolve(input.projectDirectory)).catch(() => path.resolve(input.projectDirectory as string));
    matches = matches.filter((record) => record.projectDirectory === project);
  }
  if (matches.length === 0) throw notFound(`No installed ${input.kitId} kit matches the selector.`);
  if (matches.length > 1) {
    throw conflict('Kit selector is ambiguous; use --installation-id.', {
      installation_ids: matches.map((record) => record.installationId).sort(),
    });
  }
  return matches[0] as InstalledKitRecord;
}

async function resolveTarget(
  record: InstalledKitRecord,
  paths: KkPaths,
  projector: RuntimeProjector | undefined,
) {
  const rawRoot = record.scope === 'global' ? paths.home : record.projectDirectory;
  if (!rawRoot) throw conflict('Project installation has no recorded project directory.');
  const pluginPrefix = `ak-${record.kit}`;
  const isClaudeProjectPlugin =
    record.runtime === 'claude-code' &&
    record.scope === 'project' &&
    path.resolve(record.installRoot) === path.resolve(rawRoot, pluginPrefix);
  const prefix = record.scope === 'global'
    ? `adapters/${record.runtime}/${record.kit}`
    : isClaudeProjectPlugin
      ? pluginPrefix
      : `.kk/adapters/${record.runtime}/${record.kit}`;
  const expectedRoot = path.join(rawRoot, ...prefix.split('/'));
  const expectedManifest = path.join(expectedRoot, '.kk', 'install-manifest.json');
  if (path.resolve(record.installRoot) !== path.resolve(expectedRoot) || path.resolve(record.manifestPath) !== path.resolve(expectedManifest)) {
    throw security('Installed-kit registry points outside its canonical lifecycle location.');
  }
  const root = await canonicalizeRoot(rawRoot);
  let runtimeUnprojection: PreparedRuntimeUnprojection | undefined;
  if (isClaudeProjectPlugin) {
    if (!projector) {
      throw unsupported(
        'Claude Code project-plugin uninstall is unavailable in this kk runtime.',
      );
    }
    runtimeUnprojection = await projector.prepareUninstall({
      runtime: record.runtime,
      scope: record.scope,
      kitId: record.kit,
      projectDirectory: root,
    });
    if (
      path.resolve(runtimeUnprojection.projectRoot) !== path.resolve(root) ||
      path.resolve(runtimeUnprojection.projectionRoot) !== path.resolve(expectedRoot)
    ) {
      throw security('Runtime unprojection points outside the recorded installation.');
    }
  }
  return {
    root,
    registryRoot: await canonicalizeRoot(paths.home),
    prefix,
    manifestRelativePath: `${prefix}/.kk/install-manifest.json`,
    ...(runtimeUnprojection ? { runtimeUnprojection } : {}),
  };
}

async function buildPreview(
  record: InstalledKitRecord,
  root: string,
  prefix: string,
  manifestRelativePath: string,
): Promise<UninstallPreview> {
  const groups: Record<OwnershipStatus, string[]> = {
    'owned-clean': [],
    'owned-modified': [],
    foreign: [],
    missing: [],
  };
  for (const entry of [...record.files].sort((left, right) => left.rel_path.localeCompare(right.rel_path))) {
    const classification = await classifyInstalledPath(root, `${prefix}/${entry.rel_path}`, entry.sha256);
    groups[classification.status].push(entry.rel_path);
  }
  const manifest = await classifyInstalledPath(root, manifestRelativePath, expectedManifestHash(record));
  return {
    owned_clean: groups['owned-clean'],
    owned_modified: groups['owned-modified'],
    foreign: groups.foreign,
    missing: groups.missing,
    manifest_status: manifest.status,
  };
}

function expectedManifestHash(record: InstalledKitRecord): string {
  return sha256Bytes(serializeInstallManifest(createInstallManifest({
    kit: record.kit,
    ...(record.kitVersion ? { kitVersion: record.kitVersion } : {}),
    files: record.files,
  })));
}

async function removeEmptyDirectories(starts: string[], stop: string): Promise<string[]> {
  const removed: string[] = [];
  const boundary = path.resolve(stop);
  const ordered = [...new Set(starts.map((start) => path.resolve(start)))].sort(
    (left, right) => right.split(path.sep).length - left.split(path.sep).length || left.localeCompare(right),
  );
  for (const start of ordered) {
    let current = start;
    while (current !== boundary && current.startsWith(`${boundary}${path.sep}`)) {
      try {
        await fs.rmdir(current);
        removed.push(current);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') break;
      }
      current = path.dirname(current);
    }
  }
  return [...new Set(removed)];
}

function invalidInput(message: string): KkError {
  return new KkError(message, { code: 'invalid_input', exitCode: EXIT_CODES.invalidInput });
}

function notFound(message: string): KkError {
  return new KkError(message, { code: 'not_found', exitCode: EXIT_CODES.notFound });
}

function conflict(message: string, details?: Record<string, unknown>): KkError {
  return new KkError(message, {
    code: 'conflict',
    exitCode: EXIT_CODES.conflict,
    remediation: 'Run kk doctor and select the exact installation ID.',
    ...(details ? { details } : {}),
  });
}

function security(message: string): KkError {
  return new KkError(message, { code: 'security_error', exitCode: EXIT_CODES.security });
}

function unsupported(message: string): KkError {
  return new KkError(message, {
    code: 'unsupported_environment',
    exitCode: EXIT_CODES.dependency,
    remediation: 'Install the current kk-cli release and retry.',
  });
}

function cancelled(message: string, preview: UninstallPreview): KkError {
  return new KkError(message, {
    code: 'cancelled',
    exitCode: EXIT_CODES.cancelled,
    remediation: message,
    details: { preview },
  });
}
