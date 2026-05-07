import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_MAX_TOOL_OUTPUT_CHARS } from "./constants.js";
import { boundedInt } from "./dedup.js";
import { readToolRuntime } from "./runtime-context.js";

function sanitizeName(value) {
  return String(value || "tool").replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "tool";
}

export function writeToolArtifact(label, text) {
  const { toolArtifactDir, runId } = readToolRuntime();
  if (!toolArtifactDir) return null;
  try {
    const safeRunId = sanitizeName(runId || "manual");
    const dir = resolve(toolArtifactDir, "tool-output", safeRunId);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${Date.now()}-${sanitizeName(label)}-${randomUUID()}.txt`);
    writeFileSync(path, String(text || ""), "utf8");
    return { path, bytes: Buffer.byteLength(String(text || ""), "utf8") };
  } catch {
    return null;
  }
}

export function truncationSuffix({ label, shown, total, artifact, hint }) {
  return [
    "",
    `[truncated ${label} output: showing ${shown} of ${total} characters.]`,
    artifact ? `Full output saved to: ${artifact.path}` : null,
    hint || "Use a narrower path, range, command, or query for the missing detail.",
  ].filter(Boolean).join("\n");
}

export function capChars(text, {
  label = "tool",
  maxChars = DEFAULT_MAX_TOOL_OUTPUT_CHARS,
  strategy = "head",
  hint,
} = {}) {
  const value = String(text || "");
  const limit = boundedInt(maxChars, DEFAULT_MAX_TOOL_OUTPUT_CHARS, { min: 200 });
  if (value.length <= limit) return value;
  const artifact = writeToolArtifact(label, value);
  const suffix = truncationSuffix({ label, shown: limit, total: value.length, artifact, hint });
  const budget = Math.max(0, limit - suffix.length);
  if (strategy === "head_tail" && budget > 200) {
    const head = Math.floor(budget * 0.6);
    const tail = Math.max(0, budget - head - 40);
    return `${value.slice(0, head)}\n\n[... middle omitted ...]\n\n${value.slice(Math.max(0, value.length - tail))}${suffix}`;
  }
  return `${value.slice(0, budget)}${suffix}`;
}
