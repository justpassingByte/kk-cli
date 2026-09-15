export const INSTALL_MANIFEST_VERSION = 1 as const;
export const INSTALL_MANIFEST_RELATIVE_PATH = '.agentkit/install-manifest.json';

export interface InstallManifestEntry {
  rel_path: string;
  sha256: string;
}

export interface SkillSelectionManifest {
  mode: string;
  skills: string[];
  selected_count: number;
  total_count: number;
}

/**
 * Keeps the Go CLI's v1 field names so existing installs remain readable by
 * either implementation.
 */
export interface InstallManifestV1 {
  version: typeof INSTALL_MANIFEST_VERSION;
  kit: string;
  kit_version?: string;
  files: InstallManifestEntry[];
  skill_selection?: SkillSelectionManifest;
}
