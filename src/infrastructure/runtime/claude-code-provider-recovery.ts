import fs from 'node:fs/promises';
import path from 'node:path';
import { AkError, EXIT_CODES } from '../../domain/contracts/ak-error.js';
import type {
  ClaudeProjectPluginRecovery,
  TransactionExternalRecovery,
} from '../../domain/lifecycle/filesystem-transaction.js';
import type { ClaudeProviderState } from './claude-code-cli-client.js';
import { sha256File } from '../filesystem/file-hash.js';
import {
  isRecognizedProviderRecoveryState,
  sameProviderState,
} from './claude-code-provider-recovery-state.js';

export interface ClaudeProviderRecoveryClient {
  captureProviderState(
    cwd: string,
    pluginReference: string,
  ): Promise<ClaudeProviderState>;
  addMarketplace(cwd: string): Promise<void>;
  updateMarketplace(cwd: string): Promise<void>;
  installPlugin(cwd: string, pluginReference: string): Promise<void>;
  updatePlugin(cwd: string, pluginReference: string): Promise<void>;
  uninstallPlugin(cwd: string, pluginReference: string): Promise<void>;
  enablePlugin(cwd: string, pluginReference: string): Promise<void>;
  disablePlugin(cwd: string, pluginReference: string): Promise<void>;
  removeMarketplace(cwd: string): Promise<void>;
}

export type TransactionExternalRecoveryHandler = (
  descriptor: TransactionExternalRecovery,
  direction: 'rollback' | 'commit',
) => Promise<void>;

export function createClaudeExternalRecoveryHandler(
  client: ClaudeProviderRecoveryClient,
): TransactionExternalRecoveryHandler {
  return async (descriptor, direction) => {
    if (descriptor.kind !== 'claude-code-project-plugin') {
      throw recoveryFailure('Unsupported interrupted provider recovery.');
    }
    await restoreClaudeProviderState(client, descriptor, direction);
  };
}

export async function restoreClaudeProviderState(
  client: ClaudeProviderRecoveryClient,
  descriptor: ClaudeProjectPluginRecovery,
  direction: 'rollback' | 'commit' = 'rollback',
): Promise<void> {
  const { projectRoot, pluginReference } = descriptor;
  const desired = direction === 'rollback' ? descriptor.before : descriptor.after;
  let current = await client.captureProviderState(projectRoot, pluginReference);
  assertRecognized(current, descriptor);
  await assertMarketplaceWitness(descriptor, direction);
  if (sameProviderState(current, desired)) return;
  const mutate = async (action: () => Promise<void>): Promise<void> => {
    await assertMarketplaceWitness(descriptor, direction);
    current = await client.captureProviderState(projectRoot, pluginReference);
    assertRecognized(current, descriptor);
    await action();
    await assertMarketplaceWitness(descriptor, direction);
    current = await client.captureProviderState(projectRoot, pluginReference);
    assertRecognized(current, descriptor);
  };
  if (desired.marketplaceKnown && !current.marketplaceKnown) {
    await mutate(() => client.addMarketplace(projectRoot));
  }
  if (desired.pluginInstalled) {
    if (!current.marketplaceKnown) {
      throw recoveryFailure('The AgentKit marketplace could not be restored.');
    }
    if (
      !current.pluginInstalled ||
      current.pluginVersion !== desired.pluginVersion
    ) {
      await mutate(() => client.updateMarketplace(projectRoot));
      if (current.pluginInstalled) {
        await mutate(() => client.updatePlugin(projectRoot, pluginReference));
      } else {
        await mutate(() => client.installPlugin(projectRoot, pluginReference));
      }
    }
    if (desired.pluginEnabled && !current.pluginEnabled) {
      await mutate(() => client.enablePlugin(projectRoot, pluginReference));
    }
    if (!desired.pluginEnabled && current.pluginEnabled) {
      await mutate(() => client.disablePlugin(projectRoot, pluginReference));
    }
  } else if (current.pluginInstalled) {
    await mutate(() => client.uninstallPlugin(projectRoot, pluginReference));
  }
  if (!desired.marketplaceKnown && current.marketplaceKnown) {
    if (current.marketplaceHasOtherPlugins) {
      throw providerConflict(
        'The AgentKit marketplace is now shared by another project plugin.',
      );
    }
    await mutate(() => client.removeMarketplace(projectRoot));
  }
  if (!sameProviderState(current, desired)) {
    throw recoveryFailure(
      `Claude Code could not restore ${pluginReference} after interruption.`,
    );
  }
}

function assertRecognized(
  current: ClaudeProviderState,
  descriptor: ClaudeProjectPluginRecovery,
): void {
  if (!isRecognizedProviderRecoveryState(current, descriptor)) {
    throw providerConflict(
      'Claude Code provider state changed outside the interrupted AgentKit transaction.',
    );
  }
}

export { sameProviderState } from './claude-code-provider-recovery-state.js';

async function assertMarketplaceWitness(
  descriptor: ClaudeProjectPluginRecovery,
  direction: 'rollback' | 'commit',
): Promise<void> {
  const target = path.join(
    descriptor.projectRoot,
    '.claude-plugin',
    'marketplace.json',
  );
  const info = await fs
    .lstat(target)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
  const expectedAbsent =
    direction === 'rollback' && descriptor.marketplaceBeforeAbsent === true;
  if (expectedAbsent) {
    if (info !== null) {
      throw providerConflict('The project marketplace file changed during recovery.');
    }
    return;
  }
  if (!info || !info.isFile() || info.isSymbolicLink()) {
    throw providerConflict('The project marketplace file is unavailable during recovery.');
  }
  const expectedHash =
    direction === 'rollback'
      ? descriptor.marketplaceBeforeSha256
      : descriptor.marketplaceAfterSha256;
  if (!expectedHash || (await sha256File(target)) !== expectedHash) {
    throw providerConflict('The project marketplace file changed during recovery.');
  }
}

function recoveryFailure(message: string): AkError {
  return new AkError(message, {
    code: 'runtime_error',
    exitCode: EXIT_CODES.runtime,
    remediation:
      'Run ak doctor and inspect the Claude Code project plugin state before retrying.',
  });
}

function providerConflict(message: string): AkError {
  return new AkError(message, {
    code: 'conflict',
    exitCode: EXIT_CODES.conflict,
    remediation:
      'Run ak doctor and inspect the Claude Code project plugin state before retrying.',
  });
}
