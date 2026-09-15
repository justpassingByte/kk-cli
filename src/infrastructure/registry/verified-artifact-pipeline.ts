import type { RemoteRegistryManifest } from '../../domain/registry/remote-registry-manifest.js';
import { downloadVerifiedArtifact, type ArtifactDownloadOptions } from './verified-artifact-downloader.js';
import { extractVerifiedKitArtifact } from './safe-tar-extractor.js';

export async function downloadAndExtractVerifiedKit(
  manifest: RemoteRegistryManifest,
  destination: string,
  options: ArtifactDownloadOptions = {},
): Promise<void> {
  const archive = await downloadVerifiedArtifact(manifest, options);
  await extractVerifiedKitArtifact(archive, destination, manifest.kitId);
}
