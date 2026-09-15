export type LegacyRuntime = 'claude-code' | 'codex';
export type LegacyScope = 'global' | 'project';
export type LegacyKitFamily = 'engineer' | 'marketing' | 'unknown';
export type LegacyArtifactKind = 'plugin' | 'native-skill' | 'settings' | 'source-root';

export interface LegacyCkFinding {
  runtime: LegacyRuntime;
  scope: LegacyScope;
  family: LegacyKitFamily;
  kind: LegacyArtifactKind;
  path: string;
  confidence: 'high' | 'low';
  mutationSafe: boolean;
  reason: string;
}

export interface LegacyCkDiscovery {
  schemaVersion: 1;
  findings: LegacyCkFinding[];
  warnings: string[];
}
