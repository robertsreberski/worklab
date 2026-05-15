import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import {
  DEFAULT_EXCLUDED_DIRS,
  DEFAULT_EXCLUDED_FILES,
  DEFAULT_MAX_SEARCH_CHARS,
  DEFAULT_MAX_SEARCH_LINES,
} from "./constants.js";
import { boundedInt } from "./dedup.js";
import { writeToolArtifact } from "./output-truncation.js";
import { readRuntimeBrand, readToolRuntime } from "./runtime-context.js";

const requireFromHere = createRequire(import.meta.url);

// Lazy so the message respects whatever runtimeBrand the host configured.
export function ripgrepMissingMessage() {
  const brand = readRuntimeBrand();
  return `Error: ripgrep (rg) is not available. Configure ripgrepPath via configureToolRuntime() or install ripgrep on PATH; run \`${brand.doctorCommand}\` for details.`;
}

// Mutable cache of the resolved ripgrep binary path. Stored on an object so
// callers can read the latest value without re-importing the module.
export const cachedRgPath = { value: undefined };

function vendoredRgPath() {
  try {
    const sdkPkg = requireFromHere.resolve("@anthropic-ai/claude-agent-sdk/package.json");
    const platform = process.platform === "win32" ? "win32" : process.platform;
    const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : null;
    if (!arch) return null;
    const binaryName = process.platform === "win32" ? "rg.exe" : "rg";
    const candidate = join(dirname(sdkPkg), "vendor", "ripgrep", `${arch}-${platform}`, binaryName);
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function rgFromPath() {
  const pathEnv = process.env.PATH || "";
  if (!pathEnv) return null;
  const exts = process.platform === "win32" ? (process.env.PATHEXT || ".EXE").split(";") : [""];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, `rg${ext.toLowerCase()}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export function resolveRgPath({ refresh = false } = {}) {
  if (!refresh && cachedRgPath.value !== undefined) return cachedRgPath.value;
  const { ripgrepPath } = readToolRuntime();
  if (ripgrepPath) {
    cachedRgPath.value = existsSync(ripgrepPath) ? ripgrepPath : null;
  } else {
    cachedRgPath.value = vendoredRgPath() || rgFromPath() || null;
  }
  return cachedRgPath.value;
}

export function excludedGlobArgs() {
  const args = [];
  for (const dir of DEFAULT_EXCLUDED_DIRS) {
    args.push("--glob", `!${dir}/**`, "--glob", `!**/${dir}/**`);
  }
  for (const filePattern of DEFAULT_EXCLUDED_FILES) args.push("--glob", `!${filePattern}`);
  return args;
}

export function normalizeGlobPattern(pattern) {
  const raw = String(pattern || "**/*").trim().replace(/^\.\//, "");
  return raw || "**/*";
}

export function formatSearchLines(rawLines, {
  label,
  noMatches,
  maxLines = DEFAULT_MAX_SEARCH_LINES,
  maxChars = DEFAULT_MAX_SEARCH_CHARS,
  offset = 0,
} = {}) {
  const lines = Array.isArray(rawLines) ? rawLines.filter(Boolean) : String(rawLines || "").trim().split("\n").filter(Boolean);
  if (!lines.length) return noMatches;
  const start = boundedInt(offset, 0, { min: 0 });
  const total = lines.length;
  const slice = lines.slice(start);
  const kept = [];
  let chars = 0;
  const lineLimit = boundedInt(maxLines, DEFAULT_MAX_SEARCH_LINES, { min: 1 });
  const charLimit = boundedInt(maxChars, DEFAULT_MAX_SEARCH_CHARS, { min: 200 });
  for (const line of slice) {
    if (kept.length >= lineLimit || chars + line.length + 1 > charLimit) break;
    kept.push(line);
    chars += line.length + 1;
  }
  if (kept.length === slice.length) return kept.join("\n");
  const fullText = lines.join("\n");
  const artifact = writeToolArtifact(label, fullText);
  const suffix = [
    `[truncated ${label || "search"} result: showing ${kept.length} of ${total} lines after excluding generated/vendor paths.`,
    start ? `Offset ${start} was applied.` : null,
    artifact ? `Full output saved to: ${artifact.path}` : null,
    "Use a narrower path, glob, or pattern for the full result.]",
  ].filter(Boolean).join(" ");
  return `${kept.join("\n")}\n\n${suffix}`;
}

export function capLines(text, {
  label,
  noMatches,
  maxLines = DEFAULT_MAX_SEARCH_LINES,
  maxChars = DEFAULT_MAX_SEARCH_CHARS,
  offset = 0,
} = {}) {
  return formatSearchLines(String(text || "").trim().split("\n").filter(Boolean), {
    label,
    noMatches,
    maxLines,
    maxChars,
    offset,
  });
}

export function excludedPathSummary() {
  return `Excluded directories: ${DEFAULT_EXCLUDED_DIRS.join(", ")}; excluded files: ${DEFAULT_EXCLUDED_FILES.join(", ")}.`;
}
