import { RUNTIME_CAPABILITIES, runtimeCapabilities } from "./runtime/capabilities.js";

// Back-compat export name for callers that still ask for backend capabilities.
// The canonical source is the runtime bridge registry.
export const BACKEND_CAPABILITIES = RUNTIME_CAPABILITIES;

export function backendCapabilities(sdkOrModel) {
  return runtimeCapabilities(sdkOrModel);
}

export function backendUsesExecenvConfig(sdk) {
  return !!RUNTIME_CAPABILITIES[sdk]?.native_runtime_config;
}

export function backendSupportsSessionResume(sdk) {
  return !!RUNTIME_CAPABILITIES[sdk]?.supports_session_resume;
}
