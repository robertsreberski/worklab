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
//   runtimeBrand     — resolved RuntimeBrand object (see runtime-brand.js).
//                      Internal helpers read it to stamp host-specific names
//                      (MCP client name, transcript schema id, doctor command).

import { DEFAULT_RUNTIME_BRAND, resolveRuntimeBrand } from "../../../runtime-brand.js";

const context = {
  workspace: undefined,
  repoRoot: undefined,
  runId: undefined,
  toolArtifactDir: undefined,
  ripgrepPath: undefined,
  qaOutputDir: undefined,
  runtimeBrand: { ...DEFAULT_RUNTIME_BRAND },
};

export function configureToolRuntime(next = {}) {
  for (const key of Object.keys(context)) {
    if (key === "runtimeBrand") continue;
    if (key in next) context[key] = next[key];
  }
  if (next.runtimeBrand !== undefined) {
    context.runtimeBrand = resolveRuntimeBrand(next.runtimeBrand);
  }
}

export function readToolRuntime() {
  return context;
}

export function readRuntimeBrand() {
  return context.runtimeBrand || { ...DEFAULT_RUNTIME_BRAND };
}

export function resetToolRuntime() {
  for (const key of Object.keys(context)) {
    context[key] = key === "runtimeBrand" ? { ...DEFAULT_RUNTIME_BRAND } : undefined;
  }
}
