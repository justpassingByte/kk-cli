import type {
  FilesystemTransactionExternalStep,
  TransactionFileWrite,
} from '../lifecycle/filesystem-transaction.js';

export type RuntimeProjectionScope = 'global' | 'project';

export interface RuntimeProjectionInput {
  runtime: string;
  scope: RuntimeProjectionScope;
  kitId: string;
  version: string;
  projectDirectory: string;
  artifactDirectory: string;
}

export interface PreparedExternalStep extends FilesystemTransactionExternalStep {
  id: string;
}

export interface PreparedRuntimeProjection {
  projectRoot: string;
  projectionRoot: string;
  pluginLabel: string;
  pluginReference: string;
  writes: TransactionFileWrite[];
  metadataWrites: TransactionFileWrite[];
  projectOwnership: {
    projectId: string;
    path: string;
    previousSha256?: string;
    nextSha256: string;
  };
  externalStep: PreparedExternalStep;
}

export interface RuntimeUnprojectionInput {
  runtime: string;
  scope: RuntimeProjectionScope;
  kitId: string;
  projectDirectory: string;
}

export interface PreparedRuntimeUnprojection {
  projectRoot: string;
  projectionRoot: string;
  pluginLabel: string;
  pluginReference: string;
  writes: TransactionFileWrite[];
  metadataWrites: TransactionFileWrite[];
  projectOwnership: {
    projectId: string;
    path: string;
    previousSha256: string;
    nextSha256: string;
  };
  sharedConfigResidue: boolean;
  externalStep: PreparedExternalStep;
}

export interface RuntimeProjector {
  assertSupported(
    input: Pick<RuntimeProjectionInput, 'runtime' | 'scope' | 'projectDirectory'>,
  ): Promise<void>;
  prepare(input: RuntimeProjectionInput): Promise<PreparedRuntimeProjection>;
  prepareUninstall(
    input: RuntimeUnprojectionInput,
  ): Promise<PreparedRuntimeUnprojection>;
}
