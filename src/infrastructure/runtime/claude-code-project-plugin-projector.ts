import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import semver from 'semver';
import { KkError, EXIT_CODES } from '../../domain/contracts/kk-error.js';
import type { TransactionFileWrite } from '../../domain/lifecycle/filesystem-transaction.js';
import type {
  PreparedExternalStep,
  PreparedRuntimeProjection,
  PreparedRuntimeUnprojection,
  RuntimeProjectionInput,
  RuntimeProjector,
  RuntimeUnprojectionInput,
} from '../../domain/runtime/runtime-projector.js';
import { sha256Bytes } from '../filesystem/file-hash.js';
import { assertPortableRelativePath, canonicalizeRoot } from '../filesystem/path-guard.js';
import type { ClaudeProviderState } from './claude-code-cli-client.js';
import { ClaudeCodeCliClient } from './claude-code-cli-client.js';
import {
  restoreClaudeProviderState,
  sameProviderState,
  type ClaudeProviderRecoveryClient,
} from './claude-code-provider-recovery.js';
import {
  PROJECT_RUNTIME_OWNERSHIP_RELATIVE_PATH,
  PROJECT_RUNTIME_OWNERSHIP_VERSION,
  type ProjectRuntimeOwnershipV1,
} from '../../domain/runtime/project-runtime-ownership.js';
import {
  loadProjectRuntimeOwnership,
  serializeProjectRuntimeOwnership,
} from './project-runtime-ownership-store.js';

const MARKETPLACE_NAME = 'agentkit-local';
const MARKETPLACE_PATH = '.claude-plugin/marketplace.json';
const KIT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;
const MAX_FILES = 10_000;
const MAX_BYTES = 64 * 1024 * 1024;

interface ClaudeProjectPluginClient extends ClaudeProviderRecoveryClient {
  assertSupported(cwd: string): Promise<void>;
}

interface ArtifactFile {
  relativePath: string;
  contents: Buffer;
  mode: number;
}

export class ClaudeCodeProjectPluginProjector implements RuntimeProjector {
  constructor(private readonly client: ClaudeProjectPluginClient = new ClaudeCodeCliClient()) {}

  async assertSupported(
    input: Pick<RuntimeProjectionInput, 'runtime' | 'scope' | 'projectDirectory'>,
  ): Promise<void> {
    assertSupportedTarget(input);
    const projectRoot = await canonicalizeRoot(path.resolve(input.projectDirectory));
    await this.client.assertSupported(projectRoot);
  }

  async prepare(input: RuntimeProjectionInput): Promise<PreparedRuntimeProjection> {
    assertSupportedTarget(input);
    assertSupportedKit(input);
    const pluginLabel = `ak-${input.kitId}`;
    const pluginReference = `${pluginLabel}@${MARKETPLACE_NAME}`;
    const artifactFiles = await validateAndCollectArtifact(input, pluginLabel);
    const projectRoot = await canonicalizeRoot(path.resolve(input.projectDirectory));
    const projectionRoot = path.join(projectRoot, pluginLabel);
    const ownership = await loadProjectRuntimeOwnership(projectRoot);
    const marketplaceWrite = await prepareMarketplaceWrite(
      projectRoot,
      pluginLabel,
      ownership?.state,
    );
    const writes = await prepareArtifactWrites(projectRoot, pluginLabel, artifactFiles);

    const before = await this.client.captureProviderState(projectRoot, pluginReference);
    assertProviderOwnership(ownership?.state, before, pluginReference);
    const nextOwnership = createNextOwnership(
      projectRoot,
      marketplaceWrite.nextSha256,
      ownership?.state,
      pluginReference,
      input.kitId,
      input.version,
    );
    const ownershipContents = serializeProjectRuntimeOwnership(nextOwnership);
    const ownershipWrite: TransactionFileWrite = {
      root: projectRoot,
      relativePath: PROJECT_RUNTIME_OWNERSHIP_RELATIVE_PATH,
      contents: ownershipContents,
      mode: 0o600,
      ...(ownership ? { expectedPreviousSha256: ownership.sha256 } : {}),
    };
    const externalStep = this.prepareExternalStep(
      projectRoot,
      pluginReference,
      input.version,
      before,
      marketplaceWrite.write.expectedPreviousSha256,
      marketplaceWrite.nextSha256,
    );

    return {
      projectRoot,
      projectionRoot,
      pluginLabel,
      pluginReference,
      writes: [...writes, marketplaceWrite.write],
      metadataWrites: [ownershipWrite],
      projectOwnership: {
        projectId: projectRuntimeId(projectRoot),
        path: path.join(projectRoot, ...PROJECT_RUNTIME_OWNERSHIP_RELATIVE_PATH.split('/')),
        ...(ownership ? { previousSha256: ownership.sha256 } : {}),
        nextSha256: sha256Bytes(ownershipContents),
      },
      externalStep,
    };
  }

  async prepareUninstall(
    input: RuntimeUnprojectionInput,
  ): Promise<PreparedRuntimeUnprojection> {
    assertSupportedTarget(input);
    assertSupportedKit({ kitId: input.kitId, version: '0.0.0' });
    const pluginLabel = `ak-${input.kitId}`;
    const pluginReference = `${pluginLabel}@${MARKETPLACE_NAME}`;
    const projectRoot = await canonicalizeRoot(path.resolve(input.projectDirectory));
    const projectionRoot = path.join(projectRoot, pluginLabel);
    await this.client.assertSupported(projectRoot);
    const ownership = await loadProjectRuntimeOwnership(projectRoot);
    if (!ownership || !ownership.state.plugins[pluginReference]) {
      throw conflict(`AgentKit does not own ${pluginReference} in this project.`);
    }
    const before = await this.client.captureProviderState(projectRoot, pluginReference);
    assertProviderOwnership(ownership.state, before, pluginReference);
    const marketplace = await prepareMarketplaceRemoval(
      projectRoot,
      pluginLabel,
      ownership.state,
    );
    const ownedPlugin = ownership.state.plugins[pluginReference];
    if (!ownedPlugin) {
      throw conflict(`AgentKit does not own ${pluginReference} in this project.`);
    }
    const plugins = { ...ownership.state.plugins };
    delete plugins[pluginReference];
    const residues = { ...ownership.state.residues };
    if (marketplace.residue) {
      residues[pluginReference] = {
        kitId: ownedPlugin.kitId,
        version: ownedPlugin.version,
        marketplaceEntryName: pluginLabel,
        expectedMarketplaceSha256: ownership.state.marketplaceSha256,
        removedAt: new Date().toISOString(),
      };
    }
    const nextOwnership: ProjectRuntimeOwnershipV1 = {
      ...ownership.state,
      marketplaceSha256: marketplace.nextSha256,
      plugins,
      residues,
      updatedAt: new Date().toISOString(),
    };
    const ownershipContents = serializeProjectRuntimeOwnership(nextOwnership);
    return {
      projectRoot,
      projectionRoot,
      pluginLabel,
      pluginReference,
      writes: marketplace.write ? [marketplace.write] : [],
      metadataWrites: [
        {
          root: projectRoot,
          relativePath: PROJECT_RUNTIME_OWNERSHIP_RELATIVE_PATH,
          contents: ownershipContents,
          mode: 0o600,
          expectedPreviousSha256: ownership.sha256,
        },
      ],
      projectOwnership: {
        projectId: projectRuntimeId(projectRoot),
        path: ownership.path,
        previousSha256: ownership.sha256,
        nextSha256: sha256Bytes(ownershipContents),
      },
      sharedConfigResidue: marketplace.residue,
      externalStep: this.prepareUninstallExternalStep(
        projectRoot,
        pluginReference,
        before,
        marketplace.removeProviderMarketplace,
        ownership.state.marketplaceSha256,
        marketplace.nextSha256,
      ),
    };
  }

  private prepareExternalStep(
    projectRoot: string,
    pluginReference: string,
    expectedVersion: string,
    before: ClaudeProviderState,
    marketplaceBeforeSha256: string | undefined,
    marketplaceAfterSha256: string,
  ): PreparedExternalStep {
    let providerMutationStarted = false;
    const recovery = {
      kind: 'claude-code-project-plugin' as const,
      operation: before.pluginInstalled ? 'update' as const : 'install' as const,
      marketplaceMutation: before.marketplaceKnown ? 'retain' as const : 'add' as const,
      projectRoot,
      pluginReference,
      ...(marketplaceBeforeSha256
        ? { marketplaceBeforeSha256 }
        : { marketplaceBeforeAbsent: true as const }),
      marketplaceAfterSha256,
      before,
      after: {
        pluginInstalled: true,
        pluginEnabled: true,
        pluginVersion: expectedVersion,
        marketplaceKnown: true,
        marketplaceConflict: false,
        marketplaceHasOtherPlugins: before.marketplaceHasOtherPlugins,
        marketplaceOtherPlugins: before.marketplaceOtherPlugins,
      },
    };
    return {
      id: `claude-code:project-plugin:${pluginReference}`,
      compensateAfterRollback: true,
      recovery,
      apply: async () => {
        const current = await this.client.captureProviderState(
          projectRoot,
          pluginReference,
        );
        if (!sameProviderState(current, before)) {
          throw conflict(
            `Claude Code provider state changed before updating ${pluginReference}.`,
          );
        }
        providerMutationStarted = true;
        if (before.marketplaceKnown) {
          await this.client.updateMarketplace(projectRoot);
        } else {
          await this.client.addMarketplace(projectRoot);
        }
        if (before.pluginInstalled) {
          await this.client.updatePlugin(projectRoot, pluginReference);
        } else {
          await this.client.installPlugin(projectRoot, pluginReference);
        }
      },
      verify: async () => {
        const after = await this.client.captureProviderState(projectRoot, pluginReference);
        if (
          after.marketplaceConflict ||
          !after.marketplaceKnown ||
          !after.pluginInstalled ||
          !after.pluginEnabled ||
          after.pluginVersion !== expectedVersion
        ) {
          throw runtimeFailure(
            `Claude Code did not verify ${pluginReference} as installed and enabled at project scope.`,
          );
        }
      },
      compensate: async () => {
        if (!providerMutationStarted) return;
        await restoreClaudeProviderState(this.client, recovery);
      },
    };
  }

  private prepareUninstallExternalStep(
    projectRoot: string,
    pluginReference: string,
    before: ClaudeProviderState,
    removeProviderMarketplace: boolean,
    marketplaceBeforeSha256: string,
    marketplaceAfterSha256: string,
  ): PreparedExternalStep {
    let providerMutationStarted = false;
    const recovery = {
      kind: 'claude-code-project-plugin' as const,
      operation: 'uninstall' as const,
      marketplaceMutation: removeProviderMarketplace
        ? 'remove' as const
        : 'retain' as const,
      projectRoot,
      pluginReference,
      marketplaceBeforeSha256,
      marketplaceAfterSha256,
      before,
      after: {
        pluginInstalled: false,
        pluginEnabled: false,
        marketplaceKnown:
          removeProviderMarketplace && before.marketplaceKnown
            ? false
            : before.marketplaceKnown,
        marketplaceConflict: false,
          marketplaceHasOtherPlugins:
            removeProviderMarketplace && before.marketplaceKnown
              ? false
              : before.marketplaceHasOtherPlugins,
          marketplaceOtherPlugins:
            removeProviderMarketplace && before.marketplaceKnown
              ? []
              : before.marketplaceOtherPlugins,
      },
    };
    return {
      id: `claude-code:project-plugin-uninstall:${pluginReference}`,
      position: 'before-mutations',
      compensateAfterRollback: true,
      recovery,
      apply: async () => {
        const current = await this.client.captureProviderState(
          projectRoot,
          pluginReference,
        );
        if (!sameProviderState(current, before)) {
          throw conflict(
            `Claude Code provider state changed before uninstalling ${pluginReference}.`,
          );
        }
        providerMutationStarted = true;
        if (before.pluginInstalled) {
          await this.client.uninstallPlugin(projectRoot, pluginReference);
        }
        if (removeProviderMarketplace && before.marketplaceKnown) {
          await this.client.removeMarketplace(projectRoot);
        }
      },
      verify: async () => {
        const after = await this.client.captureProviderState(projectRoot, pluginReference);
        if (after.pluginInstalled) {
          throw runtimeFailure(`Claude Code still reports ${pluginReference} as installed.`);
        }
        if (after.marketplaceConflict) {
          throw runtimeFailure('Claude Code reports a conflicting AgentKit marketplace.');
        }
        if (removeProviderMarketplace && after.marketplaceKnown) {
          throw runtimeFailure('Claude Code still reports the empty AgentKit marketplace.');
        }
      },
      compensate: async () => {
        if (!providerMutationStarted) return;
        await restoreClaudeProviderState(this.client, recovery);
      },
    };
  }
}

export function mergeClaudeMarketplaceJson(
  currentContents: string | undefined,
  pluginLabel: string,
): string {
  const marketplace = parseMarketplace(currentContents);
  const currentName = marketplace.name;
  if (currentName !== undefined && currentName !== MARKETPLACE_NAME) {
    throw conflict(
      `Project marketplace is named "${String(currentName)}"; expected "${MARKETPLACE_NAME}".`,
    );
  }
  marketplace.name = MARKETPLACE_NAME;

  if (marketplace.owner === undefined) marketplace.owner = { name: 'AgentKit' };
  if (!isObject(marketplace.owner)) throw unsafe('Marketplace owner must be an object.');
  if (marketplace.owner.name === undefined) marketplace.owner.name = 'AgentKit';

  const plugins = marketplace.plugins ?? [];
  if (!Array.isArray(plugins)) throw unsafe('Marketplace plugins must be an array.');
  const merged: Record<string, unknown>[] = [];
  let replaced = false;
  for (const candidate of plugins) {
    if (!isObject(candidate) || typeof candidate.name !== 'string' || !candidate.name.trim()) {
      throw unsafe('Marketplace plugin entries must be named objects.');
    }
    if (candidate.name !== pluginLabel) {
      merged.push(candidate);
      continue;
    }
    if (replaced) continue;
    merged.push({ ...candidate, source: `./${pluginLabel}` });
    replaced = true;
  }
  if (!replaced) merged.push({ name: pluginLabel, source: `./${pluginLabel}` });
  marketplace.plugins = merged;
  return `${JSON.stringify(marketplace, null, 2)}\n`;
}

export function removeClaudeMarketplacePluginJson(
  currentContents: string,
  pluginLabel: string,
): { contents: string; remainingPlugins: number } {
  const marketplace = parseMarketplace(currentContents);
  if (marketplace.name !== MARKETPLACE_NAME) {
    throw conflict(`Project marketplace is not owned by "${MARKETPLACE_NAME}".`);
  }
  if (!Array.isArray(marketplace.plugins)) {
    throw unsafe('Marketplace plugins must be an array.');
  }
  marketplace.plugins = marketplace.plugins.filter((candidate: unknown) => {
    if (!isObject(candidate) || typeof candidate.name !== 'string' || !candidate.name.trim()) {
      throw unsafe('Marketplace plugin entries must be named objects.');
    }
    return candidate.name !== pluginLabel;
  });
  return {
    contents: `${JSON.stringify(marketplace, null, 2)}\n`,
    remainingPlugins: marketplace.plugins.length,
  };
}

function assertSupportedTarget(
  input: Pick<RuntimeProjectionInput, 'runtime' | 'scope'>,
): void {
  if (input.runtime !== 'claude-code' || input.scope !== 'project') {
    throw unsupported(
      'The beta runtime projector only supports Claude Code project-plugin installs.',
    );
  }
}

function assertSupportedKit(input: Pick<RuntimeProjectionInput, 'kitId' | 'version'>): void {
  if (!KIT_ID_PATTERN.test(input.kitId) || input.kitId.startsWith('ak-')) {
    throw invalid('Kit id must be a bare lowercase identifier such as "engineer".');
  }
  if (semver.valid(input.version) === null) {
    throw invalid(`Kit version "${input.version}" is not valid semver.`);
  }
}

async function validateAndCollectArtifact(
  input: RuntimeProjectionInput,
  pluginLabel: string,
): Promise<ArtifactFile[]> {
  const artifactRoot = path.resolve(input.artifactDirectory);
  const rootInfo = await fs.lstat(artifactRoot).catch((error: NodeJS.ErrnoException) => {
    throw unsafe(`Verified artifact is unavailable: ${error.code ?? 'unknown error'}.`);
  });
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw unsafe('Verified artifact root must be a real directory.');
  }
  const manifestPath = path.join(artifactRoot, '.claude-plugin', 'plugin.json');
  const manifestInfo = await fs.lstat(manifestPath).catch(() => {
    throw unsafe('Verified artifact is missing .claude-plugin/plugin.json.');
  });
  if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile()) {
    throw unsafe('Verified artifact .claude-plugin/plugin.json must be a regular file.');
  }
  const manifest = parsePluginManifest(await fs.readFile(manifestPath, 'utf8'));
  if (manifest.name !== pluginLabel) {
    throw unsafe(`Plugin manifest name must be exactly "${pluginLabel}".`);
  }
  if (typeof manifest.version !== 'string' || !semver.eq(manifest.version, input.version)) {
    throw unsafe(`Plugin manifest version must match verified kit version ${input.version}.`);
  }
  return collectArtifactFiles(artifactRoot);
}

async function collectArtifactFiles(root: string): Promise<ArtifactFile[]> {
  const files: ArtifactFile[] = [];
  let totalBytes = 0;
  const walk = async (directory: string, relativeDirectory = ''): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      assertPortableRelativePath(relativePath);
      const absolutePath = path.join(directory, entry.name);
      const info = await fs.lstat(absolutePath);
      if (info.isSymbolicLink()) throw unsafe(`Artifact contains a symbolic link: ${relativePath}.`);
      if (info.isDirectory()) {
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!info.isFile()) throw unsafe(`Artifact contains an unsupported entry: ${relativePath}.`);
      if (files.length >= MAX_FILES) throw unsafe('Artifact contains too many files.');
      const contents = await fs.readFile(absolutePath);
      totalBytes += contents.byteLength;
      if (totalBytes > MAX_BYTES) throw unsafe('Artifact exceeds the 64 MiB projection limit.');
      files.push({
        relativePath,
        contents,
        mode: info.mode & 0o111 ? 0o755 : 0o644,
      });
    }
  };
  await walk(root);
  return files;
}

async function prepareArtifactWrites(
  projectRoot: string,
  pluginLabel: string,
  files: ArtifactFile[],
): Promise<TransactionFileWrite[]> {
  return files.map((file) => ({
    root: projectRoot,
    relativePath: `${pluginLabel}/${file.relativePath}`,
    contents: file.contents,
    mode: file.mode,
  }));
}

async function prepareMarketplaceWrite(
  projectRoot: string,
  pluginLabel: string,
  ownership: ProjectRuntimeOwnershipV1 | undefined,
): Promise<{ write: TransactionFileWrite; nextSha256: string }> {
  const target = path.join(projectRoot, '.claude-plugin', 'marketplace.json');
  const current = await readOptionalRegularFile(target);
  if (!ownership && current) {
    throw conflict('An unowned project marketplace already exists.');
  }
  if (ownership && (!current || sha256Bytes(current) !== ownership.marketplaceSha256)) {
    throw conflict('The owned project marketplace changed outside AgentKit.');
  }
  const contents = mergeClaudeMarketplaceJson(current?.toString('utf8'), pluginLabel);
  return {
    write: {
      root: projectRoot,
      relativePath: MARKETPLACE_PATH,
      contents,
      mode: 0o600,
      ...(ownership ? { expectedPreviousSha256: ownership.marketplaceSha256 } : {}),
    },
    nextSha256: sha256Bytes(contents),
  };
}

async function prepareMarketplaceRemoval(
  projectRoot: string,
  pluginLabel: string,
  ownership: ProjectRuntimeOwnershipV1,
): Promise<{
  write?: TransactionFileWrite;
  removeProviderMarketplace: boolean;
  nextSha256: string;
  residue: boolean;
}> {
  const target = path.join(projectRoot, '.claude-plugin', 'marketplace.json');
  const current = await readOptionalRegularFile(target);
  if (!current || sha256Bytes(current) !== ownership.marketplaceSha256) {
    return {
      removeProviderMarketplace: false,
      nextSha256: ownership.marketplaceSha256,
      residue: true,
    };
  }
  const removal = removeClaudeMarketplacePluginJson(current.toString('utf8'), pluginLabel);
  return {
    write: {
      root: projectRoot,
      relativePath: MARKETPLACE_PATH,
      contents: removal.contents,
      mode: 0o600,
      expectedPreviousSha256: ownership.marketplaceSha256,
    },
    removeProviderMarketplace: removal.remainingPlugins === 0,
    nextSha256: sha256Bytes(removal.contents),
    residue: false,
  };
}

async function readOptionalRegularFile(target: string): Promise<Buffer | undefined> {
  const info = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (info === undefined) return undefined;
  if (info.isSymbolicLink() || !info.isFile()) {
    throw conflict(`Marketplace target is not a regular file: ${target}.`);
  }
  return fs.readFile(target);
}

function createNextOwnership(
  projectRoot: string,
  marketplaceSha256: string,
  current: ProjectRuntimeOwnershipV1 | undefined,
  pluginReference: string,
  kitId: string,
  version: string,
): ProjectRuntimeOwnershipV1 {
  const residues = { ...(current?.residues ?? {}) };
  delete residues[pluginReference];
  return {
    version: PROJECT_RUNTIME_OWNERSHIP_VERSION,
    runtime: 'claude-code',
    projectDirectory: projectRoot,
    marketplaceName: MARKETPLACE_NAME,
    marketplacePath: path.join(projectRoot, '.claude-plugin', 'marketplace.json'),
    marketplaceSha256,
    providerSource: { kind: 'directory', path: projectRoot },
    plugins: {
      ...current?.plugins,
      [pluginReference]: { kitId, version, enabled: true },
    },
    residues,
    updatedAt: new Date().toISOString(),
  };
}

function assertProviderOwnership(
  ownership: ProjectRuntimeOwnershipV1 | undefined,
  provider: ClaudeProviderState,
  pluginReference: string,
): void {
  if (provider.marketplaceConflict) {
    throw conflict('A different AgentKit marketplace provider uses the same name.');
  }
  if (!ownership) {
    if (provider.marketplaceKnown || provider.pluginInstalled) {
      throw conflict('An unowned AgentKit provider object already exists.');
    }
    return;
  }
  if (Object.keys(ownership.plugins).length > 0 && !provider.marketplaceKnown) {
    throw conflict('The owned AgentKit project marketplace is not active in Claude Code.');
  }
  const expected = ownership.plugins[pluginReference];
  if (
    expected &&
    (!provider.pluginInstalled ||
      provider.pluginEnabled !== expected.enabled ||
      provider.pluginVersion !== expected.version)
  ) {
    throw conflict(`Claude Code provider state changed for ${pluginReference}.`);
  }
  if (!expected && provider.pluginInstalled) {
    throw conflict(`Claude Code reports an unowned ${pluginReference} installation.`);
  }
}

function projectRuntimeId(projectRoot: string): string {
  return `project:${createHash('sha256').update(projectRoot).digest('hex').slice(0, 16)}:claude-code`;
}

function parseMarketplace(contents: string | undefined): Record<string, any> {
  if (contents === undefined) return {};
  try {
    const parsed = JSON.parse(contents) as unknown;
    if (!isObject(parsed)) throw new Error('root is not an object');
    return parsed;
  } catch (error) {
    throw unsafe('Existing marketplace.json is not a valid JSON object.', error);
  }
}

function parsePluginManifest(contents: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(contents) as unknown;
    if (!isObject(parsed)) throw new Error('root is not an object');
    return parsed;
  } catch (error) {
    throw unsafe('Plugin manifest is not a valid JSON object.', error);
  }
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message: string): KkError {
  return new KkError(message, {
    code: 'invalid_input',
    exitCode: EXIT_CODES.invalidInput,
  });
}

function unsupported(message: string): KkError {
  return new KkError(message, {
    code: 'unsupported_environment',
    exitCode: EXIT_CODES.dependency,
    remediation: 'Choose runtime claude-code with project scope.',
  });
}

function conflict(message: string): KkError {
  return new KkError(message, {
    code: 'conflict',
    exitCode: EXIT_CODES.conflict,
    remediation: 'Resolve the conflicting project file and retry.',
  });
}

function unsafe(message: string, cause?: unknown): KkError {
  return new KkError(message, {
    code: 'security_error',
    exitCode: EXIT_CODES.security,
    remediation: 'Do not project this artifact. Resolve and verify it again.',
    ...(cause ? { cause } : {}),
  });
}

function runtimeFailure(message: string): KkError {
  return new KkError(message, {
    code: 'runtime_error',
    exitCode: EXIT_CODES.runtime,
    remediation: 'Inspect `claude plugin list --json`, then retry.',
  });
}
