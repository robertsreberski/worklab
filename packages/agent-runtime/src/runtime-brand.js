// Host-customisable identity strings used by the runtime when it has to
// stamp a name onto something that leaves the process: MCP client name,
// transcript-snapshot schema id, temp-directory prefix, the doctor command
// suggested in tool error messages, etc.
//
// Worklab ships with the defaults below ("worklab*"), so changing the brand
// is opt-in. External hosts pass `runtimeBrand` to `createRuntime` to make
// the package look like theirs without forking string-by-string.

export const DEFAULT_RUNTIME_BRAND = Object.freeze({
  schemaPrefix: "worklab",
  mcpClientName: "worklab",
  mcpClientVersion: "0.1.0",
  tempdirPrefix: "worklab-cli-",
  providerModelPrefix: "worklab",
  doctorCommand: "worklab doctor",
  // serviceName + clientInfo names propagated to provider SDKs that report
  // a client identity (Codex app-server, etc.).
  serviceName: "worklab",
  clientInfoName: "worklab",
  clientInfoTitle: "Worklab",
});

export function resolveRuntimeBrand(input) {
  if (!input || typeof input !== "object") return { ...DEFAULT_RUNTIME_BRAND };
  const out = { ...DEFAULT_RUNTIME_BRAND };
  for (const key of Object.keys(DEFAULT_RUNTIME_BRAND)) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) out[key] = value.trim();
  }
  return out;
}
