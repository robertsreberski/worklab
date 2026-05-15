export const COMMON_CAPABILITIES = {
  streaming: true,
  structured_output: true,
  supports_session_resume: false,
  native_runtime_config: null,
  supports_mcp: true,
  supports_skills: true,
  supports_builtin_tools: true,
  supports_live_input: true,
  supports_native_subagents: true,
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
  codex: {
    runtime: "cli",
    ...COMMON_CAPABILITIES,
  },
};

export function runtimeCapabilities(sdkOrModel) {
  if (!sdkOrModel) throw new Error("runtimeCapabilities requires a model reference or sdk kind");
  const sdk = typeof sdkOrModel === "string" ? sdkOrModel : sdkOrModel?.sdk;
  if (!sdk) throw new Error("runtimeCapabilities: unrecognized argument");
  const caps = RUNTIME_CAPABILITIES[sdk];
  if (!caps) throw new Error(`unknown provider sdk: ${sdk}`);
  return { kind: sdk, ...caps };
}
