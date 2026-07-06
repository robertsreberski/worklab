import { discoverOpencodeProviders } from "@mono-agent/agent-runtime/ai/providers/opencode-discovery.js";
import { commandOnPath } from "./credentials.js";

// Discovering OpenCode's providers/models boots a transient `opencode` server, so we
// cache the catalogue in-process with a short TTL. The agent editor reads it lazily
// (only when editing an agent) rather than from the hot /api/models/available path.
const DEFAULT_TTL_MS = 60_000;
let cache = null; // { at, catalogue }

export function _resetOpencodeCatalogueCache() {
  cache = null;
}

function toModelOption(provider, model) {
  const deprecated = model.status === "deprecated";
  return {
    value: `opencode:${provider.providerID}:${model.id}`,
    label: model.name || model.id,
    description: `${provider.name} / ${model.id}`,
    sdk: "opencode",
    runtime_kind: "cli",
    capabilities: {
      tool_use: model.toolCall,
      reasoning: model.reasoning,
      reasoning_mode: model.reasoning ? "effort" : "none",
      vision: model.vision,
      ...(model.contextWindow ? { context_window: model.contextWindow } : {}),
      runnable_for_agent: true,
    },
    available: !deprecated,
    disabled: deprecated,
    unavailable_reason: deprecated ? "Deprecated upstream" : null,
    // CLI runtimes use OpenCode's own tools; Worklab tools reach it via MCP.
    supports_builtin_tools: false,
    supports_worklab_tools: false,
    supports_skills: false,
    supports_mcp: true,
    native_tools_note: "OpenCode runs its own tools; Worklab tools are exposed via MCP.",
    mcp_mode: "inline-config",
  };
}

export async function getOpencodeModelCatalogue({
  ttlMs = DEFAULT_TTL_MS,
  now = Date.now,
  discover = discoverOpencodeProviders,
  isBinaryAvailable = () => commandOnPath("opencode"),
  refresh = false,
} = {}) {
  if (!isBinaryAvailable()) {
    return {
      available: false,
      reason: "Install the opencode CLI (then run `opencode auth login`) or add it to PATH.",
      groups: [],
    };
  }

  const ts = now();
  if (!refresh && cache && (ts - cache.at) < ttlMs) return cache.catalogue;

  try {
    const providers = await discover();
    const groups = (providers || [])
      .filter((provider) => (provider.models || []).length > 0)
      .map((provider) => ({
        id: `opencode:${provider.providerID}`,
        label: `OpenCode · ${provider.name}`,
        runtime_kind: "cli",
        available: true,
        disabled: false,
        unavailable_reason: null,
        models: provider.models.map((model) => toModelOption(provider, model)),
      }));
    const catalogue = { available: true, reason: null, groups };
    cache = { at: ts, catalogue };
    return catalogue;
  } catch (err) {
    return { available: false, reason: err?.message || String(err), groups: [] };
  }
}
