import fs from 'node:fs/promises';
import path from 'node:path';
import type { CommandResult } from '../domain/contracts/command-result.js';
import type {
  RegistryChannel,
  RegistryRuntime,
  RemoteRegistryManifest,
} from '../domain/registry/remote-registry-manifest.js';
import type { KitManifestResolver } from './init-use-case.js';

export interface ExportInput {
  kitId: string;
  runtime: RegistryRuntime;
  channel: RegistryChannel;
  outputPath?: string;
}

export class ExportUseCase {
  constructor(
    private readonly resolver: KitManifestResolver,
    private readonly downloadArtifact: (
      manifest: RemoteRegistryManifest,
    ) => Promise<Buffer>,
  ) {}

  async execute(input: ExportInput): Promise<CommandResult> {
    const manifest = await this.resolver.resolve({
      kitId: input.kitId,
      runtime: input.runtime,
      channel: input.channel,
    });

    const buffer = await this.downloadArtifact(manifest);

    const defaultFilename = `${manifest.kitId}-${manifest.version}.tar.gz`;
    const targetPath = input.outputPath ? path.resolve(input.outputPath) : path.resolve(process.cwd(), defaultFilename);

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, buffer);

    return {
      kind: 'kit.export',
      data: {
        kit: manifest.kitId,
        version: manifest.version,
        runtime: manifest.runtime,
        channel: manifest.channel,
        output_path: targetPath,
        size_bytes: buffer.byteLength,
        sha256: manifest.artifact.sha256,
      },
      message: `Exported ${manifest.kitId} ${manifest.version} to ${targetPath} (${buffer.byteLength} bytes).`,
    };
  }
}
