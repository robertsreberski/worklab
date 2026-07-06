import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backendCapabilities, backendUsesExecenvConfig } from "@mono-agent/agent-runtime/ai/backend.js";

// Per-task isolated artifact directory. Mirrors multica's `execenv`:
// every run gets its own `runs/{runId}` directory with `workdir`,
// `output`, and `logs` subfolders. CLI providers also receive a
// provider-native runtime config (CLAUDE.md / AGENTS.md) materialized
// into `workdir` so the agent finds task context where it natively
// expects it. SDK providers don't need the file — the same content
// reaches them via the system prompt.

export function execenvBaseDir(dataDir) {
  if (!dataDir) throw new Error("execenvBaseDir requires dataDir");
  return join(dataDir, "runs");
}

export function execenvRoot(dataDir, runId) {
  return join(execenvBaseDir(dataDir), runId);
}

export function prepareExecenv({
  dataDir,
  runId,
  agent,
  task,
  providerKind,
  systemPrompt,
}) {
  if (!dataDir || !runId) throw new Error("prepareExecenv requires dataDir and runId");
  const root = execenvRoot(dataDir, runId);
  const workdir = join(root, "workdir");
  const outputDir = join(root, "output");
  const logsDir = join(root, "logs");
  mkdirSync(workdir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });

  let runtimeConfigPath = null;
  if (providerKind && backendUsesExecenvConfig(providerKind) && systemPrompt) {
    runtimeConfigPath = writeRuntimeConfig({ workdir, providerKind, agent, task, systemPrompt });
  }

  return { root, workdir, outputDir, logsDir, runtimeConfigPath };
}

// Phase-2 helper: write the provider-native runtime config after the system
// prompt is fully assembled. The watcher creates the workdir before spawn
// so the env var is set; the worker calls this once it's built the prompt.
export function writeRuntimeConfig({ workdir, providerKind, agent, task, systemPrompt }) {
  if (!workdir || !providerKind) return null;
  if (!backendUsesExecenvConfig(providerKind)) return null;
  const caps = backendCapabilities(providerKind);
  const path = join(workdir, caps.native_runtime_config);
  writeFileSync(path, renderRuntimeConfigMarkdown({ agent, task, systemPrompt, providerKind }), "utf8");
  return path;
}

export function teardownExecenv({ dataDir, runId, keep = true }) {
  if (keep || !dataDir || !runId) return;
  const root = execenvRoot(dataDir, runId);
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

// Provider-native runtime config body. The CLI agent reads this on launch.
// We deliberately keep it self-contained: agent identity, task title, and
// the worklab system prompt block. The provider's own tooling can prepend
// its housekeeping; we don't try to replace it.
function renderRuntimeConfigMarkdown({ agent, task, systemPrompt, providerKind }) {
  const header = providerKind === "codex" ? "# Worklab agent runtime" : "# Worklab task runtime";
  const lines = [
    header,
    "",
    "<!-- Worklab regenerates this file before every run; do not edit by hand. -->",
    "",
  ];
  if (agent) {
    lines.push(`**Agent:** ${agent.display_name || agent.name}${agent.name && agent.name !== agent.display_name ? ` (\`${agent.name}\`)` : ""}`);
  }
  if (task) {
    lines.push(`**Task:** ${task.title}${task.task_key ? ` (\`${task.task_key}\`)` : ""}`);
    if (task.stage) lines.push(`**Stage:** ${task.stage}`);
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(systemPrompt || "");
  return lines.join("\n");
}
