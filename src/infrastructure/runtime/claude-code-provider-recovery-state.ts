import type { ClaudeProjectPluginRecovery } from '../../domain/lifecycle/filesystem-transaction.js';
import type { ClaudeProviderState } from './claude-code-cli-client.js';

export function isRecognizedProviderRecoveryState(
  current: ClaudeProviderState,
  descriptor: ClaudeProjectPluginRecovery,
): boolean {
  if (current.marketplaceConflict) return false;
  return recoveryStates(descriptor).some((candidate) =>
    sameProviderState(current, candidate),
  );
}

export function sameProviderState(
  left: ClaudeProviderState,
  right: ClaudeProviderState,
): boolean {
  return (
    left.pluginInstalled === right.pluginInstalled &&
    left.pluginEnabled === right.pluginEnabled &&
    left.pluginVersion === right.pluginVersion &&
    left.marketplaceKnown === right.marketplaceKnown &&
    left.marketplaceConflict === right.marketplaceConflict &&
    left.marketplaceHasOtherPlugins === right.marketplaceHasOtherPlugins &&
    JSON.stringify(left.marketplaceOtherPlugins) ===
      JSON.stringify(right.marketplaceOtherPlugins)
  );
}

function recoveryStates(
  descriptor: ClaudeProjectPluginRecovery,
): ClaudeProviderState[] {
  return uniqueStates([
    ...transitionStates(descriptor.before, descriptor.after),
    ...transitionStates(descriptor.after, descriptor.before),
  ]);
}

function transitionStates(
  source: ClaudeProviderState,
  desired: ClaudeProviderState,
): ClaudeProviderState[] {
  let current = normalizedState(source);
  const states = [current];

  if (desired.marketplaceKnown && !current.marketplaceKnown) {
    current = normalizedState({
      ...current,
      marketplaceKnown: true,
      marketplaceConflict: false,
      marketplaceHasOtherPlugins: false,
      marketplaceOtherPlugins: [],
    });
    states.push(current);
  }

  if (!samePluginState(current, desired)) {
    const afterPluginMutation = normalizedState({
      ...current,
      pluginInstalled: desired.pluginInstalled,
      pluginEnabled: desired.pluginInstalled
        ? current.pluginEnabled
        : false,
      ...(desired.pluginVersion
        ? { pluginVersion: desired.pluginVersion }
        : {}),
    });
    states.push(afterPluginMutation);
    if (desired.pluginInstalled) {
      states.push(
        normalizedState({
          ...afterPluginMutation,
          pluginEnabled: true,
        }),
      );
    }
    current = normalizedState({
      ...afterPluginMutation,
      pluginEnabled: desired.pluginEnabled,
    });
    states.push(current);
  }

  if (!desired.marketplaceKnown && current.marketplaceKnown) {
    current = normalizedState({
      ...current,
      marketplaceKnown: false,
      marketplaceConflict: false,
      marketplaceHasOtherPlugins: false,
      marketplaceOtherPlugins: [],
    });
    states.push(current);
  }
  states.push(normalizedState(desired));
  return states;
}

function samePluginState(
  left: ClaudeProviderState,
  right: ClaudeProviderState,
): boolean {
  return (
    left.pluginInstalled === right.pluginInstalled &&
    left.pluginEnabled === right.pluginEnabled &&
    left.pluginVersion === right.pluginVersion
  );
}

function normalizedState(state: ClaudeProviderState): ClaudeProviderState {
  return {
    pluginInstalled: state.pluginInstalled,
    pluginEnabled: state.pluginInstalled ? state.pluginEnabled : false,
    ...(state.pluginInstalled && state.pluginVersion
      ? { pluginVersion: state.pluginVersion }
      : {}),
    marketplaceKnown: state.marketplaceKnown,
    marketplaceConflict: state.marketplaceConflict,
    marketplaceHasOtherPlugins: state.marketplaceKnown
      ? state.marketplaceHasOtherPlugins
      : false,
    marketplaceOtherPlugins: state.marketplaceKnown
      ? [...state.marketplaceOtherPlugins].sort((left, right) =>
          left.reference.localeCompare(right.reference),
        )
      : [],
  };
}

function uniqueStates(states: ClaudeProviderState[]): ClaudeProviderState[] {
  const seen = new Set<string>();
  return states.filter((state) => {
    const key = JSON.stringify(state);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
