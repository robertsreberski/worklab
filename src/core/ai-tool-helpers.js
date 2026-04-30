import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const DEFAULT_READ_LINES = 240;
const MAX_READ_LINES = 500;
const MAX_READ_LINE_CHARS = 2_000;
const DEFAULT_MAX_READ_CHARS = 16_000;
const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 16_000;
const DEFAULT_MAX_BASH_OUTPUT_CHARS = 20_000;
const MAX_WRITE_BYTES = 10 * 1024 * 1024;
const DEFAULT_EXCLUDED_DIRS = [
  ".git",
  "node_modules",
  "dist",
  "coverage",
  "playwright-report",
  "test-results",
  ".cache",
];
const DEFAULT_EXCLUDED_FILES = ["*.map"];
const DEFAULT_MAX_SEARCH_LINES = 100;
const DEFAULT_MAX_SEARCH_CHARS = 16_000;
const SEARCH_MAX_BUFFER = 4 * 1024 * 1024;
const READ_HISTORY_LIMIT = 200;
const readHistory = new Map();

function workspaceRoot(workdir) {
  return resolve(workdir || process.env.WORKLAB_WORKSPACE || process.env.WORKLAB_REPO_ROOT || process.cwd());
}

function resolveToolPath(path, workdir) {
  if (!path || typeof path !== "string") return path;
  return resolve(isAbsolute(path) ? path : resolve(workspaceRoot(workdir), path));
}

function roots(workdir) {
  return [...new Set([
    workdir,
    process.env.WORKLAB_WORKSPACE,
    process.env.WORKLAB_REPO_ROOT,
    process.cwd(),
    "/tmp",
  ].filter(Boolean).map((p) => resolve(p)))];
}

export function isPathAllowed(path, workdir) {
  const r = resolveToolPath(path, workdir);
  return roots(workdir).some((root) => r === root || r.startsWith(root + "/"));
}

function boundedInt(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

function safeStat(path) {
  try { return statSync(path); } catch { return null; }
}

function sanitizeName(value) {
  return String(value || "tool").replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "tool";
}

function writeToolArtifact(label, text) {
  const dataDir = process.env.WORKLAB_DATA_DIR;
  if (!dataDir) return null;
  try {
    const runId = sanitizeName(process.env.WORKLAB_RUN_ID || "manual");
    const dir = resolve(dataDir, "tool-output", runId);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${Date.now()}-${sanitizeName(label)}-${randomUUID()}.txt`);
    writeFileSync(path, String(text || ""), "utf8");
    return { path, bytes: Buffer.byteLength(String(text || ""), "utf8") };
  } catch {
    return null;
  }
}

function truncationSuffix({ label, shown, total, artifact, hint }) {
  return [
    "",
    `[truncated ${label} output: showing ${shown} of ${total} characters.]`,
    artifact ? `Full output saved to: ${artifact.path}` : null,
    hint || "Use a narrower path, range, command, or query for the missing detail.",
  ].filter(Boolean).join("\n");
}

function capChars(text, {
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

function rememberRead(target, start, count) {
  const key = `${target}:${start}:${count}`;
  const repeated = readHistory.has(key);
  readHistory.set(key, Date.now());
  if (readHistory.size > READ_HISTORY_LIMIT) {
    const oldest = [...readHistory.entries()].sort((a, b) => a[1] - b[1]).slice(0, readHistory.size - READ_HISTORY_LIMIT);
    for (const [entry] of oldest) readHistory.delete(entry);
  }
  return repeated;
}

function trimLine(line) {
  const text = String(line ?? "");
  if (text.length <= MAX_READ_LINE_CHARS) return text;
  return `${text.slice(0, MAX_READ_LINE_CHARS)} [line truncated at ${MAX_READ_LINE_CHARS} of ${text.length} chars]`;
}

export async function readToolImpl({ file_path, offset = 0, start_line, limit, max_output_chars, workdir }) {
  const target = resolveToolPath(file_path, workdir);
  if (!isPathAllowed(target, workdir)) return `Error: Path not allowed: ${file_path}`;
  if (!existsSync(target)) return `Error: File not found: ${file_path}`;
  const content = readFileSync(target, "utf8");
  let lines = content.split("\n");
  const total = lines.length;
  const explicitStartLine = Number(start_line);
  const start = Number.isInteger(explicitStartLine) && explicitStartLine > 0
    ? explicitStartLine - 1
    : Math.max(0, Number(offset) || 0);
  const requested = limit == null
    ? DEFAULT_READ_LINES
    : boundedInt(limit, DEFAULT_READ_LINES, { min: 1, max: MAX_READ_LINES });
  const requestedExceeded = limit != null && Number(limit) > MAX_READ_LINES;
  lines = lines.slice(start, start + requested);
  const repeated = rememberRead(target, start, requested);
  const numbered = lines.map((line, i) => `${start + i + 1}\t${trimLine(line)}`).join("\n");
  const nextLine = start + lines.length + 1;
  const notes = [];
  if (requestedExceeded) notes.push(`Requested limit was capped at ${MAX_READ_LINES} lines.`);
  if (nextLine <= total) notes.push(`Next unread line: ${nextLine}. Continue with offset=${nextLine - 1} or start_line=${nextLine}.`);
  if (repeated) notes.push("This exact file range was already read in this process; use a narrower or later range if you need new context.");
  return capChars(`${numbered}${notes.length ? `\n\n${notes.join("\n")}` : ""}`, {
    label: "Read",
    maxChars: Number(max_output_chars) || DEFAULT_MAX_READ_CHARS,
    hint: "Use Read with offset/start_line and limit for the specific range you need.",
  });
}

export async function writeToolImpl({ file_path, content, workdir }) {
  const target = resolveToolPath(file_path, workdir);
  if (!isPathAllowed(target, workdir)) return `Error: Path not allowed: ${file_path}`;
  const bytes = Buffer.byteLength(content || "", "utf8");
  if (bytes > MAX_WRITE_BYTES) return `Error: Content too large (${bytes} bytes)`;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content || "", "utf8");
  return `Successfully wrote ${bytes} bytes to ${target}`;
}

export async function editToolImpl({ file_path, old_string, new_string, replace_all = false, workdir }) {
  const target = resolveToolPath(file_path, workdir);
  if (!isPathAllowed(target, workdir)) return `Error: Path not allowed: ${file_path}`;
  if (!existsSync(target)) return `Error: File not found: ${file_path}`;
  const content = readFileSync(target, "utf8");
  const count = content.split(old_string).length - 1;
  if (count === 0) return `Error: old_string not found in ${target}`;
  if (!replace_all && count > 1) return `Error: old_string found ${count} times`;
  writeFileSync(target, replace_all ? content.replaceAll(old_string, new_string) : content.replace(old_string, new_string), "utf8");
  return `Successfully edited ${target}`;
}

function excludedGlobArgs() {
  const args = [];
  for (const dir of DEFAULT_EXCLUDED_DIRS) {
    args.push("--glob", `!${dir}/**`, "--glob", `!**/${dir}/**`);
  }
  for (const filePattern of DEFAULT_EXCLUDED_FILES) args.push("--glob", `!${filePattern}`);
  return args;
}

function normalizeGlobPattern(pattern) {
  const raw = String(pattern || "**/*").trim().replace(/^\.\//, "");
  return raw || "**/*";
}

function formatSearchLines(rawLines, {
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

function capLines(text, {
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

function excludedPathSummary() {
  return `Excluded directories: ${DEFAULT_EXCLUDED_DIRS.join(", ")}; excluded files: ${DEFAULT_EXCLUDED_FILES.join(", ")}.`;
}

export async function globToolImpl({ pattern, path, limit, offset = 0, max_matches, max_output_chars, workdir }) {
  const cwd = resolveToolPath(path || workspaceRoot(workdir), workdir);
  if (!isPathAllowed(cwd, workdir)) return `Error: Path not allowed: ${cwd}`;
  const stat = safeStat(cwd);
  if (!stat?.isDirectory()) return `Error: Glob path is not a directory: ${cwd}`;
  const resultLimit = boundedInt(limit ?? max_matches, DEFAULT_MAX_SEARCH_LINES, { min: 1, max: 1000 });
  const args = [
    "--files",
    "--hidden",
    "--color=never",
    "--glob",
    normalizeGlobPattern(pattern),
    ...excludedGlobArgs(),
  ];
  try {
    const { stdout } = await execFileAsync("rg", args, { cwd, timeout: 15000, maxBuffer: SEARCH_MAX_BUFFER });
    const lines = stdout.trim().split("\n").filter(Boolean).sort((a, b) => {
      const aStat = safeStat(resolve(cwd, a));
      const bStat = safeStat(resolve(cwd, b));
      return (bStat?.mtimeMs || 0) - (aStat?.mtimeMs || 0) || a.localeCompare(b);
    });
    const result = formatSearchLines(lines, {
      label: "Glob",
      noMatches: "No files found matching pattern.",
      maxLines: resultLimit,
      maxChars: Number(max_output_chars) || DEFAULT_MAX_SEARCH_CHARS,
      offset,
    });
    return result === "No files found matching pattern." ? result : `${result}\n\n${excludedPathSummary()}`;
  } catch (err) {
    if (err.code === 1) return "No files found matching pattern.";
    if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || /maxBuffer/i.test(err.message || "")) {
      return `${capLines(err.stdout || "", {
        label: "Glob",
        noMatches: "Glob result exceeded the output limit before any preview could be captured.",
        maxLines: resultLimit,
        maxChars: Number(max_output_chars) || DEFAULT_MAX_SEARCH_CHARS,
        offset,
      })}\n\n${excludedPathSummary()}`;
    }
    return `Error: ${err.message}`;
  }
}

export async function grepToolImpl({
  pattern,
  path,
  glob,
  type,
  output_mode = "files_with_matches",
  context,
  case_insensitive,
  multiline,
  head_limit,
  offset = 0,
  max_matches,
  max_output_chars,
  workdir,
}) {
  const target = resolveToolPath(path || workspaceRoot(workdir), workdir);
  if (!isPathAllowed(target, workdir)) return `Error: Path not allowed: ${target}`;
  const stat = safeStat(target);
  if (!stat) return `Error: Path not found: ${target}`;
  const cwd = stat.isDirectory() ? target : dirname(target);
  const searchTarget = stat.isDirectory() ? "." : basename(target);
  const mode = ["content", "count", "files_with_matches"].includes(output_mode) ? output_mode : "files_with_matches";
  const args = ["--no-config", "--hidden", "--color=never"];
  if (mode === "files_with_matches") args.push("--files-with-matches");
  else if (mode === "count") args.push("--count-matches");
  else args.push("--line-number");
  if (case_insensitive) args.push("-i");
  if (mode === "content" && context) args.push(`-C${boundedInt(context, 0, { min: 0, max: 20 })}`);
  if (multiline) args.push("-U", "--multiline-dotall");
  if (glob) args.push("--glob", glob);
  if (type) args.push("--type", type);
  args.push(...excludedGlobArgs(), "--", pattern, searchTarget);
  const resultLimit = boundedInt(head_limit ?? max_matches, DEFAULT_MAX_SEARCH_LINES, { min: 1, max: 1000 });
  try {
    const { stdout } = await execFileAsync("rg", args, { cwd, timeout: 15000, maxBuffer: SEARCH_MAX_BUFFER });
    const normalized = stdout.trim().split("\n").filter(Boolean).map((line) => line.replace(/^\.\//, ""));
    const formatted = capLines(normalized.join("\n"), {
      label: "Grep",
      noMatches: "No matches found.",
      maxLines: resultLimit,
      maxChars: Number(max_output_chars) || DEFAULT_MAX_SEARCH_CHARS,
      offset,
    });
    return formatted === "No matches found." ? formatted : `${formatted}\n\n${excludedPathSummary()}`;
  } catch (err) {
    if (err.code === 1) return "No matches found.";
    if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || /maxBuffer/i.test(err.message || "")) {
      return `${capLines(err.stdout || "", {
        label: "Grep",
        noMatches: "Grep result exceeded the output limit before any preview could be captured.",
        maxLines: resultLimit,
        maxChars: Number(max_output_chars) || DEFAULT_MAX_SEARCH_CHARS,
        offset,
      })}\n\n${excludedPathSummary()}`;
    }
    return `Error: ${err.message}`;
  }
}

export async function bashToolImpl({ command, timeout = 120000, max_output_chars, workdir }) {
  const cwd = workspaceRoot(workdir);
  if (!isPathAllowed(cwd, workdir)) return `Error: Working directory not allowed: ${cwd}`;
  if (!existsSync(cwd)) return `Error: Working directory not found: ${cwd}`;
  const maxChars = Number(max_output_chars) || DEFAULT_MAX_BASH_OUTPUT_CHARS;
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      shell: "/bin/bash",
    });
    const output = stdout && stderr ? `STDOUT:\n${stdout}\nSTDERR:\n${stderr}` : (stdout || stderr || "(no output)");
    return capChars(output, { label: "Bash", maxChars, strategy: "head_tail" });
  } catch (err) {
    if (err.killed) return `Error: Command timed out after ${timeout}ms`;
    return capChars(`Exit code ${err.code || 1}:\n${err.stdout || ""}${err.stderr || err.message}`, {
      label: "Bash",
      maxChars,
      strategy: "head_tail",
    });
  }
}

export async function webFetchToolImpl({ url, headers = {}, max_output_chars }) {
  const maxChars = Number(max_output_chars) || DEFAULT_MAX_TOOL_OUTPUT_CHARS;
  try { new URL(url); } catch { return "Error: Invalid URL"; }
  try {
    const resp = await fetch(url, { headers: { "User-Agent": "Worklab/0.1", ...headers }, signal: AbortSignal.timeout(15000) });
    const text = await resp.text();
    if (!resp.ok) return `HTTP ${resp.status}: ${text.slice(0, 500)}`;
    return capChars(text, { label: "WebFetch", maxChars });
  } catch (err) {
    return `Error fetching URL: ${err.message}`;
  }
}

export async function webSearchToolImpl({ query, limit = 5 }) {
  const max = Math.min(Math.max(Number(limit) || 5, 1), 10);
  const resp = await fetch(`https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { "User-Agent": "Mozilla/5.0 Worklab/0.1" },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) return `Search failed: HTTP ${resp.status}`;
  const html = await resp.text();
  const results = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && results.length < max) {
    results.push(`${m[2].replace(/<[^>]+>/g, "").trim()}\n${m[1]}\n${m[3].replace(/<[^>]+>/g, "").trim()}`);
  }
  return results.length ? results.join("\n\n") : "No results.";
}
