import type { InstallManifestEntry } from '../kits/install-manifest.js';

export type OwnershipStatus = 'owned-clean' | 'owned-modified' | 'foreign' | 'missing';
export type TransactionMutationKind =
  | 'write'
  | 'delete'
  | 'metadata'
  | 'manifest'
  | 'registry';

export interface OwnershipClassification {
  root: string;
  relativePath: string;
  status: OwnershipStatus;
  expectedSha256?: string;
  actualSha256?: string;
}

export interface TransactionFileWrite {
  root: string;
  relativePath: string;
  contents: Uint8Array | string;
  mode?: number;
  expectedPreviousSha256?: string;
}

export interface TransactionStaleFile {
  root: string;
  entry: InstallManifestEntry;
}

export interface TransactionMutation {
  kind: TransactionMutationKind;
  root: string;
  relativePath: string;
}

export interface FilesystemTransactionHooks {
  revalidate?: () => void | Promise<void>;
  afterSnapshot?: (snapshotPath: string) => void | Promise<void>;
  beforeMutation?: (mutation: TransactionMutation) => void | Promise<void>;
  afterMutation?: (mutation: TransactionMutation) => void | Promise<void>;
  beforeRollback?: (mutation: TransactionMutation) => void | Promise<void>;
}

export interface FilesystemTransactionExternalStep {
  id?: string;
  position?: 'before-mutations' | 'before-metadata';
  compensateAfterRollback?: boolean;
  recovery?: ClaudeProjectPluginRecovery;
  apply: () => void | Promise<void>;
  verify: () => void | Promise<void>;
  compensate: () => void | Promise<void>;
}

export interface ClaudeProjectPluginRecovery {
  kind: 'claude-code-project-plugin';
  operation: 'install' | 'update' | 'uninstall';
  marketplaceMutation: 'add' | 'remove' | 'retain';
  projectRoot: string;
  pluginReference: string;
  marketplaceBeforeSha256?: string;
  marketplaceBeforeAbsent?: true;
  marketplaceAfterSha256: string;
  before: {
    pluginInstalled: boolean;
    pluginEnabled: boolean;
    pluginVersion?: string;
    marketplaceKnown: boolean;
    marketplaceConflict: boolean;
    marketplaceHasOtherPlugins: boolean;
    marketplaceOtherPlugins: Array<{
      reference: string;
      enabled: boolean;
      version?: string;
    }>;
  };
  after: {
    pluginInstalled: boolean;
    pluginEnabled: boolean;
    pluginVersion?: string;
    marketplaceKnown: boolean;
    marketplaceConflict: boolean;
    marketplaceHasOtherPlugins: boolean;
    marketplaceOtherPlugins: Array<{
      reference: string;
      enabled: boolean;
      version?: string;
    }>;
  };
}

export type TransactionExternalRecovery = ClaudeProjectPluginRecovery;

export interface FilesystemTransactionPlan {
  roots: string[];
  snapshotDirectory: string;
  recoveryDirectory: string;
  writes: TransactionFileWrite[];
  staleFiles?: TransactionStaleFile[];
  metadataWrites?: TransactionFileWrite[];
  manifestDelete?: TransactionStaleFile;
  manifestCommit?: TransactionFileWrite;
  registryCommit?: TransactionFileWrite;
  externalStep?: FilesystemTransactionExternalStep;
  hooks?: FilesystemTransactionHooks;
}

export interface FilesystemTransactionResult {
  transactionId: string;
  snapshotPath: string;
  classifications: OwnershipClassification[];
  mutations: TransactionMutation[];
  recoveryReceiptPath?: string;
}
