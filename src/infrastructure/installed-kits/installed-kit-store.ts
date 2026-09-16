import fs from 'node:fs/promises';
import path from 'node:path';
import { KkError, EXIT_CODES } from '../../domain/contracts/kk-error.js';
import {
  INSTALL_MANIFEST_VERSION,
  type InstallManifestEntry,
  type InstallManifestV1,
  type SkillSelectionManifest,
} from '../../domain/kits/install-manifest.js';
import {
  INSTALLED_KIT_REGISTRY_VERSION,
  emptyInstalledKitRegistry,
  type InstalledKitRecord,
  type InstalledKitRegistryV1,
  type ProjectRuntimeRegistryRecord,
} from '../../domain/kits/installed-kit-registry.js';
import { atomicWriteFile } from '../filesystem/atomic-write.js';
import { isSha256 } from '../filesystem/file-hash.js';
import {
  assertPortableRelativePath,
  canonicalizeRoot,
  isPathWithinRoot,
  resolveWithinRoot,
} from '../filesystem/path-guard.js';

function invalidState(message: string, cause?: unknown): KkError {
  return new KkError(message, {
    code: 'security_error',
    exitCode: EXIT_CODES.security,
    remediation: 'Run kk doctor and inspect the installed-kit ownership metadata before retrying.',
    cause,
  });
}

export class InstalledKitStore {
  constructor(private readonly registryPath: string) {}

  async load(): Promise<InstalledKitRegistryV1> {
    const data = await readRegularTextFile(this.registryPath);
    if (data === null) return emptyInstalledKitRegistry();
    try {
      return parseInstalledKitRegistry(JSON.parse(data) as unknown);
    } catch (error) {
      if (error instanceof KkError) throw error;
      throw invalidState(`Installed-kit registry is invalid: ${this.registryPath}`, error);
    }
  }

  async save(registry: InstalledKitRegistryV1): Promise<void> {
    const validated = parseInstalledKitRegistry(registry);
    const parent = path.dirname(this.registryPath);
    await fs.mkdir(parent, { recursive: true, mode: 0o750 });
    const root = await canonicalizeRoot(parent);
    await atomicWriteFile(root, path.basename(this.registryPath), serializeJson(validated));
  }

  prepareUpsert(record: InstalledKitRecord, current: InstalledKitRegistryV1): InstalledKitRegistryV1 {
    return parseInstalledKitRegistry({
      version: INSTALLED_KIT_REGISTRY_VERSION,
      kits: { ...current.kits, [record.installationId]: record },
      ...(current.projects ? { projects: current.projects } : {}),
    });
  }

  prepareUpsertProject(
    record: ProjectRuntimeRegistryRecord,
    current: InstalledKitRegistryV1,
  ): InstalledKitRegistryV1 {
    return parseInstalledKitRegistry({
      version: INSTALLED_KIT_REGISTRY_VERSION,
      kits: current.kits,
      projects: { ...current.projects, [record.projectId]: record },
    });
  }

  prepareRemove(
    installationId: string,
    current: InstalledKitRegistryV1,
  ): InstalledKitRegistryV1 {
    const kits = { ...current.kits };
    delete kits[installationId];
    return parseInstalledKitRegistry({
      version: INSTALLED_KIT_REGISTRY_VERSION,
      kits,
      ...(current.projects ? { projects: current.projects } : {}),
    });
  }
}

export async function readInstallManifest(manifestPath: string): Promise<InstallManifestV1 | null> {
  const data = await readRegularTextFile(manifestPath);
  if (data === null) return null;
  try {
    return parseInstallManifest(JSON.parse(data) as unknown);
  } catch (error) {
    if (error instanceof KkError) throw error;
    throw invalidState(`Install manifest is invalid: ${manifestPath}`, error);
  }
}

export function createInstallManifest(options: {
  kit: string;
  kitVersion?: string;
  files: InstallManifestEntry[];
  skillSelection?: SkillSelectionManifest;
}): InstallManifestV1 {
  const manifest: InstallManifestV1 = {
    version: INSTALL_MANIFEST_VERSION,
    kit: options.kit,
    files: [...options.files].sort((left, right) => left.rel_path.localeCompare(right.rel_path)),
  };
  if (options.kitVersion !== undefined) manifest.kit_version = options.kitVersion;
  if (options.skillSelection !== undefined) manifest.skill_selection = options.skillSelection;
  return parseInstallManifest(manifest);
}

export function serializeRegistry(registry: InstalledKitRegistryV1): string {
  return serializeJson(parseInstalledKitRegistry(registry));
}

export function serializeInstallManifest(manifest: InstallManifestV1): string {
  return serializeJson(parseInstallManifest(manifest));
}

function parseInstalledKitRegistry(value: unknown): InstalledKitRegistryV1 {
  if (!isRecord(value) || value.version !== INSTALLED_KIT_REGISTRY_VERSION || !isRecord(value.kits)) {
    throw invalidState('Unsupported installed-kit registry schema.');
  }
  const kits: Record<string, InstalledKitRecord> = {};
  for (const [key, rawRecord] of Object.entries(value.kits)) {
    if (!isRecord(rawRecord) || rawRecord.installationId !== key) {
      throw invalidState(`Installed-kit registry record ${JSON.stringify(key)} is invalid.`);
    }
    const required = [
      rawRecord.kit,
      rawRecord.runtime,
      rawRecord.scope,
      rawRecord.channel,
      rawRecord.installRoot,
      rawRecord.manifestPath,
      rawRecord.installedAt,
      rawRecord.updatedAt,
    ];
    if (required.some((field) => typeof field !== 'string' || field.length === 0) || !Array.isArray(rawRecord.files)) {
      throw invalidState(`Installed-kit registry record ${JSON.stringify(key)} is incomplete.`);
    }
    if (
      !path.isAbsolute(rawRecord.installRoot as string) ||
      !path.isAbsolute(rawRecord.manifestPath as string) ||
      !isPathWithinRoot(rawRecord.installRoot as string, rawRecord.manifestPath as string)
    ) {
      throw invalidState(`Installed-kit registry record ${JSON.stringify(key)} has unsafe paths.`);
    }
    const files = parseManifestEntries(rawRecord.files);
    const record: InstalledKitRecord = {
      installationId: key,
      kit: rawRecord.kit as string,
      runtime: parseEnum(rawRecord.runtime, ['claude-code', 'codex', 'cursor'], 'runtime'),
      scope: parseEnum(rawRecord.scope, ['global', 'project'], 'scope'),
      channel: parseEnum(rawRecord.channel, ['dev', 'beta', 'stable'], 'channel'),
      installRoot: rawRecord.installRoot as string,
      manifestPath: rawRecord.manifestPath as string,
      installedAt: rawRecord.installedAt as string,
      updatedAt: rawRecord.updatedAt as string,
      files,
    };
    if (rawRecord.kitVersion !== undefined && typeof rawRecord.kitVersion !== 'string') {
      throw invalidState(`Installed-kit registry record ${JSON.stringify(key)} has an invalid kit version.`);
    }
    if (typeof rawRecord.kitVersion === 'string') record.kitVersion = rawRecord.kitVersion;
    if (
      rawRecord.projectDirectory !== undefined &&
      (typeof rawRecord.projectDirectory !== 'string' ||
        !path.isAbsolute(rawRecord.projectDirectory))
    ) {
      throw invalidState(`Installed-kit registry record ${JSON.stringify(key)} has an invalid project directory.`);
    }
    if (typeof rawRecord.projectDirectory === 'string') {
      record.projectDirectory = rawRecord.projectDirectory;
    }
    if (record.scope === 'project' && record.projectDirectory === undefined) {
      throw invalidState(`Installed-kit registry record ${JSON.stringify(key)} is missing its project directory.`);
    }
    if (
      record.scope === 'project' &&
      record.projectDirectory !== undefined &&
      !isPathWithinRoot(record.projectDirectory, record.installRoot)
    ) {
      throw invalidState(`Installed-kit registry record ${JSON.stringify(key)} escapes its project.`);
    }
    kits[key] = record;
  }
  const projects = parseProjectRuntimeRecords(value.projects);
  return {
    version: INSTALLED_KIT_REGISTRY_VERSION,
    kits,
    ...(projects ? { projects } : {}),
  };
}

function parseProjectRuntimeRecords(
  value: unknown,
): Record<string, ProjectRuntimeRegistryRecord> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw invalidState('Installed-kit project runtime registry is invalid.');
  const projects: Record<string, ProjectRuntimeRegistryRecord> = {};
  for (const [projectId, raw] of Object.entries(value)) {
    if (
      !isRecord(raw) ||
      raw.projectId !== projectId ||
      typeof raw.projectDirectory !== 'string' ||
      !path.isAbsolute(raw.projectDirectory) ||
      raw.runtime !== 'claude-code' ||
      typeof raw.ownershipPath !== 'string' ||
      !path.isAbsolute(raw.ownershipPath) ||
      !isPathWithinRoot(raw.projectDirectory, raw.ownershipPath) ||
      !isSha256(raw.ownershipSha256) ||
      typeof raw.updatedAt !== 'string'
    ) {
      throw invalidState(`Installed-kit project runtime record ${projectId} is invalid.`);
    }
    projects[projectId] = {
      projectId,
      projectDirectory: raw.projectDirectory,
      runtime: 'claude-code',
      ownershipPath: raw.ownershipPath,
      ownershipSha256: raw.ownershipSha256,
      updatedAt: raw.updatedAt,
    };
  }
  return projects;
}

function parseEnum<const T extends string>(
  value: unknown,
  values: readonly T[],
  field: string,
): T {
  if (typeof value === 'string' && values.includes(value as T)) return value as T;
  throw invalidState(`Installed-kit registry ${field} is invalid.`);
}

function parseInstallManifest(value: unknown): InstallManifestV1 {
  if (
    !isRecord(value) ||
    value.version !== INSTALL_MANIFEST_VERSION ||
    typeof value.kit !== 'string' ||
    value.kit.trim() === '' ||
    !Array.isArray(value.files)
  ) {
    throw invalidState('Unsupported install manifest schema.');
  }
  const manifest: InstallManifestV1 = {
    version: INSTALL_MANIFEST_VERSION,
    kit: value.kit,
    files: parseManifestEntries(value.files),
  };
  if (value.files.length === 0) throw invalidState('Install manifest must record at least one payload file.');
  if (value.kit_version !== undefined && typeof value.kit_version !== 'string') {
    throw invalidState('Install manifest kit_version is invalid.');
  }
  if (typeof value.kit_version === 'string') manifest.kit_version = value.kit_version;
  if (value.skill_selection !== undefined && !isSkillSelection(value.skill_selection)) {
    throw invalidState('Install manifest skill_selection is invalid.');
  }
  if (isSkillSelection(value.skill_selection)) manifest.skill_selection = value.skill_selection;
  return manifest;
}

function parseManifestEntries(values: unknown[]): InstallManifestEntry[] {
  const seen = new Set<string>();
  return values.map((value) => {
    if (!isRecord(value) || typeof value.rel_path !== 'string' || !isSha256(value.sha256)) {
      throw invalidState('Install manifest contains an invalid ownership entry.');
    }
    assertPortableRelativePath(value.rel_path);
    const portableKey = value.rel_path.toLowerCase();
    if (seen.has(portableKey)) throw invalidState(`Duplicate manifest path: ${value.rel_path}`);
    seen.add(portableKey);
    return { rel_path: value.rel_path, sha256: value.sha256 };
  });
}

function isSkillSelection(value: unknown): value is SkillSelectionManifest {
  return (
    isRecord(value) &&
    typeof value.mode === 'string' &&
    Array.isArray(value.skills) &&
    value.skills.every((skill) => typeof skill === 'string') &&
    Number.isSafeInteger(value.selected_count) &&
    Number.isSafeInteger(value.total_count) &&
    (value.selected_count as number) >= 0 &&
    (value.total_count as number) >= (value.selected_count as number) &&
    value.skills.length === value.selected_count
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function readRegularTextFile(filePath: string): Promise<string | null> {
  const info = await fs.lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (info === null) return null;
  if (!info.isFile()) throw invalidState(`Ownership metadata is not a regular file: ${filePath}`);
  const root = await canonicalizeRoot(path.dirname(filePath));
  const target = await resolveWithinRoot(root, path.basename(filePath));
  return fs.readFile(target, 'utf8');
}
