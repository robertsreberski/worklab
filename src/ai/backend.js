// Static capability map per provider kind. The runtime/native_runtime_config
// fields drive execenv decisions (per-task workdir + provider-native config
// file). supports_session_resume reflects whether the runtime can resume a
// prior session ID — only Claude Code CLI exposes this today.
//
// Lives in src/ai/ because providers are the only consumers; PR-13/PR-14
// inverted the back-import. The PROVIDER_KINDS list duplicates the canonical
// list in core/agent-contract.js for the local validation below — keep them
// in sync if a new SDK is added.

const PROVIDER_KINDS = ["claude", "openai", "vercel", "claude-code", "codex", "pi"];

export const BACKEND_CAPABILITIES = {
  claude: {
    runtime: "sdk",
    streaming: true,
    structured_output: true,
    supports_session_resume: false,
    native_runtime_config: null,
    supports_mcp: true,
    supports_skills: true,
    supports_builtin_tools: true,
    supports_live_input: true,
  },
  openai: {
    runtime: "pi-agent",
    streaming: true,
    structured_output: true,
    supports_session_resume: false,
    native_runtime_config: null,
    supports_mcp: true,
    supports_skills: true,
    supports_builtin_tools: true,
    supports_live_input: true,
  },
  vercel: {
    runtime: "pi-agent",
    streaming: true,
    structured_output: true,
    supports_session_resume: false,
    native_runtime_config: null,
    supports_mcp: true,
    supports_skills: true,
    supports_builtin_tools: true,
    supports_live_input: true,
  },
  "claude-code": {
    runtime: "sdk",
    streaming: true,
    structured_output: true,
    supports_session_resume: false,
    native_runtime_config: null,
    supports_mcp: true,
    supports_skills: true,
    supports_builtin_tools: true,
    supports_live_input: true,
  },
  codex: {
    runtime: "pi-agent",
    streaming: true,
    structured_output: true,
    supports_session_resume: false,
    native_runtime_config: null,
    supports_mcp: true,
    supports_skills: true,
    supports_builtin_tools: true,
    supports_live_input: true,
  },
  pi: {
    runtime: "pi-agent",
    streaming: true,
    structured_output: true,
    supports_session_resume: false,
    native_runtime_config: null,
    supports_mcp: true,
    supports_skills: true,
    supports_builtin_tools: true,
    supports_live_input: true,
  },
};

export function backendCapabilities(sdkOrModel) {
  if (!sdkOrModel) throw new Error("backendCapabilities requires a model reference or sdk kind");
  let sdk;
  if (typeof sdkOrModel === "string") {
    if (PROVIDER_KINDS.includes(sdkOrModel)) sdk = sdkOrModel;
    else throw new Error(`unknown provider sdk: ${sdkOrModel}`);
  } else if (sdkOrModel?.sdk) {
    sdk = sdkOrModel.sdk;
  } else {
    throw new Error("backendCapabilities: unrecognized argument");
  }
  const caps = BACKEND_CAPABILITIES[sdk];
  if (!caps) throw new Error(`unknown provider sdk: ${sdk}`);
  return { kind: sdk, ...caps };
}

export function backendUsesExecenvConfig(sdk) {
  return !!BACKEND_CAPABILITIES[sdk]?.native_runtime_config;
}

export function backendSupportsSessionResume(sdk) {
  return !!BACKEND_CAPABILITIES[sdk]?.supports_session_resume;
}
