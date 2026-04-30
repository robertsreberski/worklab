// Provider registry. The agent kernel and the rest of the app dispatch model
// references through this module. Phase 3 wires the existing adapters
// (claude-sdk, pi-sdk, claude-cli, codex-cli, codex-app) in; until then the
// registry is empty and core/ai.js continues to dispatch via switch.

const providers = new Map();

/**
 * Register a provider implementation.
 * @param {import("./types.js").ApiProvider} provider
 */
export function registerProvider(provider) {
  if (!provider?.id) throw new Error("provider.id is required");
  providers.set(provider.id, provider);
}

/**
 * Look up a provider by id (e.g. "claude", "pi", "claude-cli").
 * @param {string} id
 * @returns {import("./types.js").ApiProvider | undefined}
 */
export function getProvider(id) {
  return providers.get(id);
}

/**
 * Find a provider that says it supports the given model reference.
 * @param {import("./types.js").ProviderModelRef} ref
 */
export function findProviderForModel(ref) {
  for (const provider of providers.values()) {
    try {
      if (provider.supports?.(ref)) return provider;
    } catch {
      // ignore broken supports() implementations during dispatch
    }
  }
  return undefined;
}

export function listProviders() {
  return Array.from(providers.values());
}

export function clearProviders() {
  providers.clear();
}
