// Top-level runtime factory.
//
// `createRuntime(host)` is the ergonomic entry point for hosts. It binds the
// host integration callbacks (pricing, persistence, credentials), configures
// the module-level tool runtime, and returns a `.run(systemPrompt, options)`
// method that resolves the right provider bridge based on `options.model` +
// `options.executionMode`.
//
// All four built-in bridges (claude-sdk, claude-cli, pi-sdk, codex-app)
// register themselves on import via the runtime registry. Hosts that need
// finer control can keep using the named exports (resolveRuntimeBridge,
// generateClaudeResponse, etc.) directly.
//
// Return shape from `.run()`:
//   { text, structuredResult, structuredResultSource, events, usage,
//     durationMs, numTurns, model, effort, sdk, cancelled, error,
//     errorDetails, failureKind, providerSessionId, runtimeWarnings,
//     diagnostics }
//
// `text` is the raw assistant text. `structuredResult` is whatever JSON the
// agent returned via the configured outputSchema (undefined when no schema
// was supplied). Hosts that want a domain-specific contract (worklab_result,
// task envelopes, etc.) parse it themselves.

import { resolveRuntimeBridge } from "./ai/runtime/registry.js";
import { createObserverHub } from "./ai/observer.js";
import { configureToolRuntime } from "./agent/tools/shared/runtime-context.js";
import { resolveRuntimeBrand } from "./runtime-brand.js";

const HOST_KEYS = [
  "resolveCustomPricing",
  "resolvePiApiKey",
  "persistArtifact",
  "onCompactionRecorded",
  "onToolApprovalRequest",
  "toolRiskTiers",
  "approvalDefaultRiskTier",
  "approvalTimeoutMs",
  "approvalAlwaysAllowTools",
];

const TOOL_RUNTIME_KEYS = [
  "workspace",
  "repoRoot",
  "ripgrepPath",
  "qaOutputDir",
];

function pickDefined(source, keys) {
  const out = {};
  for (const key of keys) {
    if (source && source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

export function createRuntime(host = {}) {
  const hostDefaults = pickDefined(host, HOST_KEYS);
  const toolRuntime = pickDefined(host, TOOL_RUNTIME_KEYS);
  const runtimeBrand = resolveRuntimeBrand(host.runtimeBrand);
  const hostObservers = Array.isArray(host.observers) ? host.observers.slice() : [];
  // Always configure: even when no tool keys are supplied, we must publish
  // the resolved brand so internal modules (transcript, pi-bridge, ripgrep
  // error message) pick it up. The brand defaults preserve worklab strings.
  configureToolRuntime({ ...toolRuntime, runtimeBrand });

  return {
    async run(systemPrompt, options = {}) {
      if (!options.model) throw new Error("createRuntime.run requires options.model");
      const executionMode = typeof options.executionMode === "string" ? options.executionMode : "sdk";
      const bridge = await resolveRuntimeBridge(options.model, {
        liveInput: !!options.liveInput,
        executionMode,
      });
      const callObservers = Array.isArray(options.observers) ? options.observers : [];
      const hub = createObserverHub({
        observers: [...hostObservers, ...callObservers],
        onEvent: options.onEvent,
      });
      const result = await bridge.execute(systemPrompt, {
        ...hostDefaults,
        ...options,
        executionMode,
        runtimeBrand,
        observerHub: hub,
        onEvent: hub.emit,
      });
      await hub.flush();
      return result;
    },
    configureTools(next = {}) {
      configureToolRuntime(pickDefined(next, TOOL_RUNTIME_KEYS));
    },
  };
}
