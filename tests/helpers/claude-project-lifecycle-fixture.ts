import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { InitUseCase } from '../../src/application/init-use-case.js';
import type { RemoteRegistryManifest } from '../../src/domain/registry/remote-registry-manifest.js';
import { LocalFilesystemTransaction } from '../../src/infrastructure/filesystem/local-filesystem-transaction.js';
import { InstalledKitStore } from '../../src/infrastructure/installed-kits/installed-kit-store.js';
import type { AgentKitPaths } from '../../src/infrastructure/paths/agentkit-paths.js';
import { ClaudeCodeProjectPluginProjector } from '../../src/infrastructure/runtime/claude-code-project-plugin-projector.js';
import type { PromptService } from '../../src/presentation/prompt-service.js';

export interface ProviderPluginState {
  installed: boolean;
  enabled: boolean;
  version?: string;
}

export class FakeClaudeProjectClient {
  marketplaceKnown = false;
  marketplaceConflict = false;
  failVerification = false;
  readonly plugins = new Map<string, ProviderPluginState>();
  readonly operations: string[] = [];

  async assertSupported(): Promise<void> {}

  async captureProviderState(_cwd: string, reference: string) {
    const plugin = this.plugins.get(reference);
    return {
      pluginInstalled: plugin?.installed ?? false,
      pluginEnabled: plugin?.enabled ?? false,
      ...(plugin?.version ? { pluginVersion: plugin.version } : {}),
      marketplaceKnown: this.marketplaceKnown,
      marketplaceConflict: this.marketplaceConflict,
      marketplaceHasOtherPlugins: [...this.plugins.entries()].some(
        ([candidate, state]) =>
          candidate !== reference &&
          candidate.endsWith('@agentkit-local') &&
          state.installed,
      ),
      marketplaceOtherPlugins: [...this.plugins.entries()]
        .filter(
          ([candidate, state]) =>
            candidate !== reference &&
            candidate.endsWith('@agentkit-local') &&
            state.installed,
        )
        .map(([candidate, state]) => ({
          reference: candidate,
          enabled: state.enabled,
          ...(state.version ? { version: state.version } : {}),
        }))
        .sort((left, right) => left.reference.localeCompare(right.reference)),
    };
  }

  async addMarketplace(): Promise<void> {
    this.operations.push('marketplace:add');
    this.marketplaceKnown = true;
  }

  async updateMarketplace(): Promise<void> {
    this.operations.push('marketplace:update');
  }

  async installPlugin(cwd: string, reference: string): Promise<void> {
    this.operations.push(`plugin:install:${reference}`);
    await this.setPluginFromSource(cwd, reference);
  }

  async updatePlugin(cwd: string, reference: string): Promise<void> {
    this.operations.push(`plugin:update:${reference}`);
    await this.setPluginFromSource(cwd, reference);
  }

  async uninstallPlugin(_cwd: string, reference: string): Promise<void> {
    this.operations.push(`plugin:uninstall:${reference}`);
    this.plugins.set(reference, { installed: false, enabled: false });
  }

  async disablePlugin(_cwd: string, reference: string): Promise<void> {
    this.operations.push(`plugin:disable:${reference}`);
    const current = this.plugins.get(reference);
    this.plugins.set(reference, {
      installed: current?.installed ?? true,
      enabled: false,
      ...(current?.version ? { version: current.version } : {}),
    });
  }

  async enablePlugin(_cwd: string, reference: string): Promise<void> {
    this.operations.push(`plugin:enable:${reference}`);
    const current = this.plugins.get(reference);
    this.plugins.set(reference, {
      installed: current?.installed ?? true,
      enabled: true,
      ...(current?.version ? { version: current.version } : {}),
    });
  }

  async removeMarketplace(): Promise<void> {
    this.operations.push('marketplace:remove');
    this.marketplaceKnown = false;
    for (const reference of this.plugins.keys()) {
      this.plugins.set(reference, { installed: false, enabled: false });
    }
  }

  private async setPluginFromSource(cwd: string, reference: string): Promise<void> {
    const label = reference.split('@')[0] as string;
    const manifest = JSON.parse(
      await fs.readFile(
        path.join(cwd, label, '.claude-plugin', 'plugin.json'),
        'utf8',
      ),
    ) as { version: string };
    this.plugins.set(reference, {
      installed: true,
      enabled: !this.failVerification,
      version: manifest.version,
    });
  }
}

export async function createLifecycleFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ak-project-lifecycle-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'Project with spaces 🚀');
  await fs.mkdir(home);
  await fs.mkdir(project);
  const paths: AgentKitPaths = {
    home: await fs.realpath(home),
    credentials: path.join(home, 'credentials.json'),
    installedKits: path.join(home, 'installed-kits.json'),
    locks: path.join(home, 'locks'),
    snapshots: path.join(home, 'snapshots'),
    recovery: path.join(home, 'recovery'),
    supportReports: path.join(home, 'support-reports'),
  };
  return {
    root,
    project: await fs.realpath(project),
    paths,
    store: new InstalledKitStore(paths.installedKits),
    client: new FakeClaudeProjectClient(),
  };
}

export function createInit(
  fixture: Awaited<ReturnType<typeof createLifecycleFixture>>,
  version: string,
  transaction: LocalFilesystemTransaction = new LocalFilesystemTransaction(),
  kitId = 'engineer',
) {
  const manifest = manifestFor(kitId, version);
  const resolver = { resolve: vi.fn(async () => manifest) };
  const projector = new ClaudeCodeProjectPluginProjector(fixture.client);
  const useCase = new InitUseCase(
    resolver,
    async (_manifest, destination) => writeArtifact(destination, kitId, version),
    fixture.paths,
    fixture.store,
    transaction,
    prompts(),
    projector,
  );
  return { useCase, resolver, projector };
}

export function manifestFor(kitId: string, version: string): RemoteRegistryManifest {
  return {
    schemaVersion: 'remote-registry.v1',
    kitId,
    runtime: 'claude-code',
    version,
    channel: 'stable',
    adapterSchemaVersion: 'agentkit-adapter.v1',
    requiredCliVersion: '',
    sourceCommit: 'abcdef1',
    createdAt: '2026-07-28T00:00:00Z',
    artifact: {
      url: 'https://example.test/kit.tar.gz',
      sha256: 'a'.repeat(64),
      size: 1,
      signature: Buffer.alloc(64).toString('base64'),
      signatureAlgorithm: 'ed25519',
      keyId: 'test-key',
      expiresAt: '2026-07-28T00:10:00Z',
    },
  };
}

async function writeArtifact(
  destination: string,
  kitId: string,
  version: string,
): Promise<void> {
  const root = path.join(destination, kitId);
  await fs.mkdir(path.join(root, '.claude-plugin'), { recursive: true });
  await fs.mkdir(path.join(root, 'skills', 'demo'), { recursive: true });
  await fs.writeFile(path.join(root, 'kit.yaml'), `id: ${kitId}\n`);
  await fs.writeFile(
    path.join(root, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: `ak-${kitId}`, version }),
  );
  await fs.writeFile(path.join(root, 'skills', 'demo', 'SKILL.md'), '# Demo\n');
}

function prompts(): PromptService {
  return {
    chooseAuthMethod: vi.fn(),
    email: vi.fn(),
    otp: vi.fn(),
    apiKey: vi.fn(),
    confirm: vi.fn(async () => true),
  };
}
