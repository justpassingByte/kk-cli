import type { InstallManifestEntry } from './install-manifest.js';

export const INSTALLED_KIT_REGISTRY_VERSION = 1 as const;

export interface InstalledKitRecord {
  installationId: string;
  kit: string;
  kitVersion?: string;
  runtime: 'claude-code' | 'codex' | 'cursor' | 'agy' | 'antigravity';
  scope: 'global' | 'project';
  channel: 'dev' | 'beta' | 'stable';
  projectDirectory?: string;
  installRoot: string;
  manifestPath: string;
  files: InstallManifestEntry[];
  installedAt: string;
  updatedAt: string;
}

export interface ProjectRuntimeRegistryRecord {
  projectId: string;
  projectDirectory: string;
  runtime: 'claude-code' | 'agy' | 'antigravity';
  ownershipPath: string;
  ownershipSha256: string;
  updatedAt: string;
}

export interface InstalledKitRegistryV1 {
  version: typeof INSTALLED_KIT_REGISTRY_VERSION;
  kits: Record<string, InstalledKitRecord>;
  projects?: Record<string, ProjectRuntimeRegistryRecord>;
}

export function emptyInstalledKitRegistry(): InstalledKitRegistryV1 {
  return { version: INSTALLED_KIT_REGISTRY_VERSION, kits: {} };
}
