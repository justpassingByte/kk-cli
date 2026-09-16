import fs from 'node:fs/promises';
import path from 'node:path';
import { KkError, EXIT_CODES } from '../domain/contracts/kk-error.js';
import type { CommandResult } from '../domain/contracts/command-result.js';
import type {
  RegistryChannel,
  RegistryRuntime,
  RemoteRegistryManifest,
} from '../domain/registry/remote-registry-manifest.js';
import type { RuntimeProjector } from '../domain/runtime/runtime-projector.js';
import type { LocalFilesystemTransaction } from '../infrastructure/filesystem/local-filesystem-transaction.js';
import type { InstalledKitStore } from '../infrastructure/installed-kits/installed-kit-store.js';
import { collectStagedKitFiles } from '../infrastructure/kits/staged-kit-files.js';
import type { KkPaths } from '../infrastructure/paths/kk-paths.js';
import type { PromptService } from '../presentation/prompt-service.js';
import { prepareKitInstall, type KitScope } from './kit-install-plan.js';
import { extractLocalKit } from '../infrastructure/registry/local-kit-extractor.js';

export interface InitInput {
  kitId: string;
  runtime: RegistryRuntime;
  channel: RegistryChannel;
  scope: KitScope;
  projectDirectory?: string;
  yes: boolean;
  noInteractive: boolean;
  from?: string;
}

export interface KitManifestResolver {
  resolve(input: {
    kitId: string;
    runtime: RegistryRuntime;
    channel: RegistryChannel;
  }): Promise<RemoteRegistryManifest>;
}

export class InitUseCase {
  constructor(
    private readonly resolver: KitManifestResolver,
    private readonly downloadAndExtract: (
      manifest: RemoteRegistryManifest,
      destination: string,
    ) => Promise<void>,
    private readonly paths: KkPaths,
    private readonly store: InstalledKitStore,
    private readonly transaction: LocalFilesystemTransaction,
    private readonly prompts: PromptService,
    private readonly projector: RuntimeProjector,
  ) {}

  async execute(input: InitInput): Promise<CommandResult> {
    await this.transaction.recover(this.paths.snapshots, this.paths.recovery);
    const projectDirectory = input.projectDirectory ?? process.cwd();
    await this.projector.assertSupported({
      runtime: input.runtime,
      scope: input.scope,
      projectDirectory,
    });

    const stagingParent = path.join(this.paths.home, 'tmp');
    await fs.mkdir(stagingParent, { recursive: true, mode: 0o700 });
    const stagingRoot = await fs.mkdtemp(path.join(stagingParent, 'kit-install-'));
    const extractedRoot = path.join(stagingRoot, 'verified');
    try {
      let manifest: RemoteRegistryManifest;
      if (input.from) {
        const localExtracted = await extractLocalKit(input.from, extractedRoot, input.kitId);
        manifest = {
          schemaVersion: 'remote-registry.v1',
          kitId: localExtracted.kitId,
          tier: 'paid',
          runtime: input.runtime,
          version: localExtracted.version,
          channel: input.channel,
          adapterSchemaVersion: 'agentkit-adapter.v1',
          requiredCliVersion: '',
          sourceCommit: 'dry-run',
          createdAt: new Date().toISOString(),
          artifact: {
            url: 'https://localhost/local-kit.tar.gz',
            sha256: '0'.repeat(64),
            size: 1024,
            signature: Buffer.alloc(64).toString('base64'),
            signatureAlgorithm: 'ed25519',
            keyId: 'prod-2026-07',
            expiresAt: new Date(Date.now() + 86400000).toISOString(),
          },
          dependencies: [],
        };
        await this.confirmMutation(input, manifest);
      } else {
        manifest = await this.resolver.resolve({
          kitId: input.kitId,
          runtime: input.runtime,
          channel: input.channel,
        });
        await this.confirmMutation(input, manifest);
        await this.downloadAndExtract(manifest, extractedRoot);
      }

      const files = await collectStagedKitFiles(extractedRoot, manifest.kitId);
      const projection = await this.projector.prepare({
        runtime: manifest.runtime,
        scope: input.scope,
        kitId: manifest.kitId,
        version: manifest.version,
        projectDirectory,
        artifactDirectory: path.join(extractedRoot, manifest.kitId),
      });
      const prepared = await prepareKitInstall(
        {
          kitId: manifest.kitId,
          version: manifest.version,
          runtime: manifest.runtime,
          channel: manifest.channel,
          scope: input.scope,
          ...(input.projectDirectory ? { projectDirectory: input.projectDirectory } : {}),
        },
        files,
        this.paths,
        this.store,
        projection,
      );
      const result = await this.transaction.run(prepared.transaction);
      return {
        kind: 'kit.init',
        data: {
          installation_id: prepared.installationId,
          kit: manifest.kitId,
          runtime: manifest.runtime,
          scope: input.scope,
          channel: manifest.channel,
          version: manifest.version,
          previous_version: prepared.previousVersion,
          install_root: prepared.installRoot,
          transaction_id: result.transactionId,
          snapshot_path: result.snapshotPath,
          changed_files: result.mutations.length,
        },
        message: prepared.previousVersion
          ? `Updated ${manifest.kitId} from ${prepared.previousVersion} to ${manifest.version}.`
          : `Installed ${manifest.kitId} ${manifest.version} for ${manifest.runtime}.`,
      };
    } finally {
      await fs.rm(stagingRoot, { recursive: true, force: true });
    }
  }

  private async confirmMutation(
    input: InitInput,
    manifest: RemoteRegistryManifest,
  ): Promise<void> {
    if (input.yes) return;
    const target = `${manifest.kitId} ${manifest.version} for ${manifest.runtime} (${input.scope})`;
    if (!input.noInteractive && process.stdin.isTTY) {
      if (await this.prompts.confirm(`Install ${target}?`, true)) return;
      throw cancelled('Nothing changed.');
    }
    throw cancelled(
      `Installation needs confirmation. Review the target, then run kk init --kit ${manifest.kitId} --runtime ${manifest.runtime} --scope ${input.scope} --yes.`,
    );
  }
}

function cancelled(message: string): KkError {
  return new KkError(message, {
    code: 'cancelled',
    exitCode: EXIT_CODES.cancelled,
    ...(message.startsWith('Installation needs') ? { remediation: message } : {}),
  });
}
