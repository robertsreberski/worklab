const COMMON_CAPABILITIES = {
  streaming: true,
  structured_output: true,
  supports_session_resume: false,
  native_runtime_config: null,
  supports_mcp: true,
  supports_skills: true,
  supports_builtin_tools: true,
  supports_live_input: true,
};

export const RUNTIME_CAPABILITIES = {
  claude: {
    runtime: "sdk",
    ...COMMON_CAPABILITIES,
  },
  pi: {
    runtime: "pi-agent",
    ...COMMON_CAPABILITIES,
  },
};

const builtinBridgeSpecs = {
  claude: {
    id: "claude",
    supports: (ref) => ref?.sdk === "claude",
    capabilities: () => runtimeCapabilities("claude"),
    load: async () => (await import("../providers/claude-sdk.js")).claudeRuntimeBridge,
  },
  pi: {
    id: "pi",
    supports: (ref) => ref?.sdk === "pi",
    capabilities: () => runtimeCapabilities("pi"),
    load: async () => (await import("../providers/pi-sdk.js")).piRuntimeBridge,
  },
};

export function listRuntimeBridges() {
  return Object.values(builtinBridgeSpecs).map((bridge) => ({
    id: bridge.id,
    supports: bridge.supports,
    capabilities: bridge.capabilities,
  }));
}

export function runtimeCapabilities(sdkOrModel) {
  if (!sdkOrModel) throw new Error("runtimeCapabilities requires a model reference or sdk kind");
  const sdk = typeof sdkOrModel === "string" ? sdkOrModel : sdkOrModel?.sdk;
  if (!sdk) throw new Error("runtimeCapabilities: unrecognized argument");
  const caps = RUNTIME_CAPABILITIES[sdk];
  if (!caps) throw new Error(`unknown provider sdk: ${sdk}`);
  return { kind: sdk, ...caps };
}

export async function resolveRuntimeBridge(modelRef) {
  for (const spec of Object.values(builtinBridgeSpecs)) {
    if (spec.supports(modelRef)) return spec.load();
  }
  throw new Error(`unsupported sdk: ${modelRef?.sdk || "unknown"}`);
}
