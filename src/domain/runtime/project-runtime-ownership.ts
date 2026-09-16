export const PROJECT_RUNTIME_OWNERSHIP_VERSION = 1 as const;
export const PROJECT_RUNTIME_OWNERSHIP_RELATIVE_PATH =
  '.kk/runtime-ownership.json';

export interface OwnedProjectPlugin {
  kitId: string;
  version: string;
  enabled: boolean;
}

export interface ProjectRuntimeResidue {
  kitId: string;
  version: string;
  marketplaceEntryName: string;
  expectedMarketplaceSha256: string;
  removedAt: string;
}

export interface ProjectRuntimeOwnershipV1 {
  version: typeof PROJECT_RUNTIME_OWNERSHIP_VERSION;
  runtime: 'claude-code' | 'agy' | 'antigravity';
  projectDirectory: string;
  marketplaceName: string;
  marketplacePath: string;
  marketplaceSha256: string;
  providerSource: {
    kind: 'directory';
    path: string;
  };
  plugins: Record<string, OwnedProjectPlugin>;
  residues: Record<string, ProjectRuntimeResidue>;
  updatedAt: string;
}
