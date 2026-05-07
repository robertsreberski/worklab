// Process-level configuration for the agent kernel's internal tool helpers.
// Worklab (or any other host) configures this once at worker boot; internal
// modules (output-truncation, ripgrep, path-resolver, pi-bridge) read from
// it instead of reaching into process.env.
//
// Single shared object is acceptable because the worker is one-task-per-process.
//
// Recognized keys:
//   workspace        — fallback for tool workdir resolution. Default: process.cwd().
//   repoRoot         — secondary allowed root (the host's installation root).
//                      Tool path-allowlist checks accept this in addition to workspace.
//   runId            — used as the subdirectory under toolArtifactDir for tool output.
//   toolArtifactDir  — root for {dir}/tool-output/{runId}/{file} artifact writes
//                      from capChars/formatSearchLines. Null = no persistence.
//   ripgrepPath      — absolute path to the ripgrep binary. When unset, falls
//                      back to vendored binary, then PATH lookup.
//   qaOutputDir      — fallback for normalizeMcpToolParams when the per-call
//                      runArtifactDir isn't supplied.

const context = {
  workspace: undefined,
  repoRoot: undefined,
  runId: undefined,
  toolArtifactDir: undefined,
  ripgrepPath: undefined,
  qaOutputDir: undefined,
};

export function configureToolRuntime(next = {}) {
  for (const key of Object.keys(context)) {
    if (key in next) context[key] = next[key];
  }
}

export function readToolRuntime() {
  return context;
}

export function resetToolRuntime() {
  for (const key of Object.keys(context)) context[key] = undefined;
}
