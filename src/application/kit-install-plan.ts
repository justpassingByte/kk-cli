import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AkError, EXIT_CODES } from '../domain/contracts/ak-error.js';
import type { FilesystemTransactionPlan } from '../domain/lifecycle/filesystem-transaction.js';
import {
  INSTALL_MANIFEST_RELATIVE_PATH,
  type InstallManifestV1,
} from '../domain/kits/install-manifest.js';
import type {
  InstalledKitRecord,
  InstalledKitRegistryV1,
} from '../domain/kits/installed-kit-registry.js';
import type { AgentKitPaths } from '../infrastructure/paths/agentkit-paths.js';
import { sha256File } from '../infrastructure/filesystem/file-hash.js';
import {
  createInstallManifest,
  readInstallManifest,
  serializeInstallManifest,
  serializeRegistry,
} from '../infrastructure/installed-kits/installed-kit-store.js';
import type { InstalledKitStore } from '../infrastructure/installed-kits/installed-kit-store.js';
import type { StagedKitFile } from '../infrastructure/kits/staged-kit-files.js';
import { toManifestEntries } from '../infrastructure/kits/staged-kit-files.js';
import type {
  RegistryChannel,
  RegistryRuntime,
} from '../domain/registry/remote-registry-manifest.js';
import type { PreparedRuntimeProjection } from '../domain/runtime/runtime-projector.js';

export type KitScope = 'global' | 'project';

export interface KitInstallTarget {
  kitId: string;
  version: string;
  runtime: RegistryRuntime;
  channel: RegistryChannel;
  scope: KitScope;
  projectDirectory?: string;
}

export interface PreparedKitInstall {
  installationId: string;
  installRoot: string;
  manifest: InstallManifestV1;
  registry: InstalledKitRegistryV1;
  transaction: FilesystemTransactionPlan;
  previousVersion?: string;
}

export async function prepareKitInstall(
  target: KitInstallTarget,
  files: StagedKitFile[],
  paths: AgentKitPaths,
  store: InstalledKitStore,
  projection?: PreparedRuntimeProjection,
): Promise<PreparedKitInstall> {
  const projectDirectory =
    target.scope === 'project'
      ? await requireProjectDirectory(target.projectDirectory)
      : undefined;
  const lifecycleRoot = projection
    ? projection.projectRoot
    : target.scope === 'global'
      ? paths.home
      : path.join(projectDirectory as string, '.agentkit');
  await fs.mkdir(paths.home, { recursive: true, mode: 0o750 });
  await fs.mkdir(lifecycleRoot, { recursive: true, mode: 0o750 });

  if (
    projection &&
    path.resolve(projection.projectRoot) !== path.resolve(projectDirectory as string)
  ) {
    throw conflict('Runtime projection points at a different project directory.');
  }
  const installPrefix = projection
    ? projection.pluginLabel
    : `adapters/${target.runtime}/${target.kitId}`;
  const installRoot = path.join(lifecycleRoot, ...installPrefix.split('/'));
  const manifestRelativePath = `${installPrefix}/${INSTALL_MANIFEST_RELATIVE_PATH}`;
  const manifestPath = path.join(installRoot, ...INSTALL_MANIFEST_RELATIVE_PATH.split('/'));
  const installationId = createInstallationId(target, projectDirectory);
  const currentRegistry = await store.load();
  const currentRecord = currentRegistry.kits[installationId];
  if (currentRecord && path.resolve(currentRecord.installRoot) !== path.resolve(installRoot)) {
    throw conflict('Installed-kit registry points this installation at a different path.');
  }

  const oldManifest = await readInstallManifest(manifestPath);
  if (oldManifest && oldManifest.kit !== target.kitId) {
    throw conflict('Existing ownership manifest belongs to a different kit.');
  }
  if (currentRecord && !oldManifest) {
    throw conflict('Installed-kit registry exists but its ownership manifest is missing.');
  }
  if (oldManifest && !currentRecord) {
    throw conflict(
      'An ownership manifest exists without a matching installed-kit registry record.',
    );
  }
  if (
    currentRecord &&
    oldManifest &&
    (oldManifest.kit_version !== currentRecord.kitVersion ||
      serializeEntries(oldManifest.files) !== serializeEntries(currentRecord.files))
  ) {
    throw conflict(
      'Installed-kit registry and ownership manifest do not describe the same files.',
    );
  }
  const oldByPath = new Map(oldManifest?.files.map((entry) => [entry.rel_path, entry.sha256]));
  const newEntries = toManifestEntries(files);
  const manifest = createInstallManifest({
    kit: target.kitId,
    kitVersion: target.version,
    files: newEntries,
  });
  const now = new Date().toISOString();
  const record: InstalledKitRecord = {
    installationId,
    kit: target.kitId,
    kitVersion: target.version,
    runtime: target.runtime,
    scope: target.scope,
    channel: target.channel,
    ...(projectDirectory ? { projectDirectory } : {}),
    installRoot,
    manifestPath,
    files: newEntries,
    installedAt: currentRecord?.installedAt || now,
    updatedAt: now,
  };
  let nextRegistry = store.prepareUpsert(record, currentRegistry);
  if (projection) {
    validateProjectOwnershipRegistry(
      projection,
      projectDirectory as string,
      currentRegistry,
    );
    nextRegistry = store.prepareUpsertProject(
      {
        projectId: projection.projectOwnership.projectId,
        projectDirectory: projectDirectory as string,
        runtime: 'claude-code',
        ownershipPath: projection.projectOwnership.path,
        ownershipSha256: projection.projectOwnership.nextSha256,
        updatedAt: now,
      },
      nextRegistry,
    );
  }
  const newPaths = new Set(newEntries.map((entry) => entry.rel_path));
  const roots = lifecycleRoot === paths.home ? [paths.home] : [paths.home, lifecycleRoot];
  const registryHash = await hashIfPresent(paths.installedKits);
  const manifestHash = await hashIfPresent(manifestPath);

  return {
    installationId,
    installRoot,
    manifest,
    registry: nextRegistry,
    transaction: {
      roots,
      snapshotDirectory: paths.snapshots,
      recoveryDirectory: paths.recovery,
      writes: projection
        ? prepareProjectionWrites(projection, installPrefix, oldByPath)
        : files.map((file) => {
            const expectedPreviousSha256 = oldByPath.get(file.relativePath);
            return {
              root: lifecycleRoot,
              relativePath: `${installPrefix}/${file.relativePath}`,
              contents: file.contents,
              mode: file.mode,
              ...(expectedPreviousSha256 ? { expectedPreviousSha256 } : {}),
            };
          }),
      staleFiles: (oldManifest?.files || [])
        .filter((entry) => !newPaths.has(entry.rel_path))
        .map((entry) => ({
          root: lifecycleRoot,
          entry: {
            rel_path: `${installPrefix}/${entry.rel_path}`,
            sha256: entry.sha256,
          },
        })),
      ...(projection
        ? {
            metadataWrites: [
              ...projection.metadataWrites,
              {
                root: lifecycleRoot,
                relativePath: manifestRelativePath,
                contents: serializeInstallManifest(manifest),
                ...(manifestHash ? { expectedPreviousSha256: manifestHash } : {}),
              },
            ],
          }
        : {
            manifestCommit: {
              root: lifecycleRoot,
              relativePath: manifestRelativePath,
              contents: serializeInstallManifest(manifest),
              ...(manifestHash ? { expectedPreviousSha256: manifestHash } : {}),
            },
          }),
      registryCommit: {
        root: paths.home,
        relativePath: path.basename(paths.installedKits),
        contents: serializeRegistry(nextRegistry),
        ...(registryHash ? { expectedPreviousSha256: registryHash } : {}),
      },
      ...(projection ? { externalStep: projection.externalStep } : {}),
      hooks: {
        revalidate: async () => {
          const fresh = await store.load();
          if (serializeRegistry(fresh) !== serializeRegistry(currentRegistry)) {
            throw conflict('Installed-kit registry changed while preparing the operation.');
          }
        },
      },
    },
    ...(oldManifest?.kit_version ? { previousVersion: oldManifest.kit_version } : {}),
  };
}

function serializeEntries(entries: InstallManifestV1['files']): string {
  return JSON.stringify(
    [...entries].sort((left, right) => left.rel_path.localeCompare(right.rel_path)),
  );
}

function validateProjectOwnershipRegistry(
  projection: PreparedRuntimeProjection,
  projectDirectory: string,
  currentRegistry: InstalledKitRegistryV1,
): void {
  const currentProject =
    currentRegistry.projects?.[projection.projectOwnership.projectId];
  const previousSha256 = projection.projectOwnership.previousSha256;
  if (!currentProject && !previousSha256) return;
  if (
    !currentProject ||
    !previousSha256 ||
    currentProject.projectDirectory !== projectDirectory ||
    currentProject.runtime !== 'claude-code' ||
    path.resolve(currentProject.ownershipPath) !==
      path.resolve(projection.projectOwnership.path) ||
    currentProject.ownershipSha256 !== previousSha256
  ) {
    throw conflict(
      'Global registry and project runtime ownership metadata do not agree.',
    );
  }
}

function prepareProjectionWrites(
  projection: PreparedRuntimeProjection,
  installPrefix: string,
  oldByPath: Map<string, string>,
) {
  const prefix = `${installPrefix}/`;
  return projection.writes.map((write) => {
    if (path.resolve(write.root) !== path.resolve(projection.projectRoot)) {
      throw conflict('Runtime projection contains a write outside the project root.');
    }
    if (!write.relativePath.startsWith(prefix)) return write;
    const ownedRelativePath = write.relativePath.slice(prefix.length);
    const expectedOwnedHash = oldByPath.get(ownedRelativePath);
    if (write.expectedPreviousSha256 && !expectedOwnedHash) {
      throw conflict(
        `Refusing to replace foreign file ${write.relativePath}; it is not owned by AgentKit.`,
      );
    }
    const ownedWrite = { ...write };
    delete ownedWrite.expectedPreviousSha256;
    return {
      ...ownedWrite,
      ...(expectedOwnedHash ? { expectedPreviousSha256: expectedOwnedHash } : {}),
    };
  });
}

function createInstallationId(
  target: KitInstallTarget,
  projectDirectory: string | undefined,
): string {
  if (!projectDirectory) return `global:${target.runtime}:${target.kitId}`;
  const projectId = createHash('sha256').update(projectDirectory).digest('hex').slice(0, 16);
  return `project:${projectId}:${target.runtime}:${target.kitId}`;
}

async function requireProjectDirectory(value: string | undefined): Promise<string> {
  if (!value) throw conflict('Project scope requires a project directory.');
  try {
    const resolved = await fs.realpath(path.resolve(value));
    const stat = await fs.lstat(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('not a real directory');
    return resolved;
  } catch (error) {
    throw conflict('Project directory is unavailable or unsafe.', error);
  }
}

async function hashIfPresent(filePath: string): Promise<string | undefined> {
  try {
    return await sha256File(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function conflict(message: string, cause?: unknown): AkError {
  return new AkError(message, {
    code: 'conflict',
    exitCode: EXIT_CODES.conflict,
    remediation: 'Run ak doctor and review the existing installation before retrying.',
    cause,
  });
}
