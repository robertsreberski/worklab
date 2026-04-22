import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const MAX_READ_LINES = 2000;
const MAX_WRITE_BYTES = 10 * 1024 * 1024;

function roots() {
  return [...new Set([
    process.env.WORKLAB_WORKSPACE,
    process.env.WORKLAB_REPO_ROOT,
    process.cwd(),
    "/tmp",
  ].filter(Boolean).map((p) => resolve(p)))];
}

export function isPathAllowed(path) {
  const r = resolve(path);
  return roots().some((root) => r === root || r.startsWith(root + "/"));
}

export async function readToolImpl({ file_path, offset = 0, limit }) {
  if (!isPathAllowed(file_path)) return `Error: Path not allowed: ${file_path}`;
  if (!existsSync(file_path)) return `Error: File not found: ${file_path}`;
  const content = readFileSync(file_path, "utf8");
  let lines = content.split("\n");
  const total = lines.length;
  const start = Number(offset) || 0;
  if (start || limit) lines = lines.slice(start, limit ? start + Number(limit) : undefined);
  const truncated = lines.length > MAX_READ_LINES;
  if (truncated) lines = lines.slice(0, MAX_READ_LINES);
  const numbered = lines.map((line, i) => `${start + i + 1}\t${line}`).join("\n");
  return `${numbered}${truncated ? `\n... (${total - MAX_READ_LINES} more lines)` : ""}`;
}

export async function writeToolImpl({ file_path, content }) {
  if (!isPathAllowed(file_path)) return `Error: Path not allowed: ${file_path}`;
  const bytes = Buffer.byteLength(content || "", "utf8");
  if (bytes > MAX_WRITE_BYTES) return `Error: Content too large (${bytes} bytes)`;
  mkdirSync(dirname(file_path), { recursive: true });
  writeFileSync(file_path, content || "", "utf8");
  return `Successfully wrote ${bytes} bytes to ${file_path}`;
}

export async function editToolImpl({ file_path, old_string, new_string, replace_all = false }) {
  if (!isPathAllowed(file_path)) return `Error: Path not allowed: ${file_path}`;
  if (!existsSync(file_path)) return `Error: File not found: ${file_path}`;
  const content = readFileSync(file_path, "utf8");
  const count = content.split(old_string).length - 1;
  if (count === 0) return `Error: old_string not found in ${file_path}`;
  if (!replace_all && count > 1) return `Error: old_string found ${count} times`;
  writeFileSync(file_path, replace_all ? content.replaceAll(old_string, new_string) : content.replace(old_string, new_string), "utf8");
  return `Successfully edited ${file_path}`;
}

export async function globToolImpl({ pattern, path }) {
  const cwd = resolve(path || process.env.WORKLAB_WORKSPACE || process.cwd());
  if (!isPathAllowed(cwd)) return `Error: Path not allowed: ${cwd}`;
  const args = [cwd, "-type", "f"];
  if (pattern.includes("/") || pattern.includes("**")) args.push("-path", `*/${pattern.replace(/\*\*\//g, "*/")}`);
  else args.push("-name", pattern);
  const { stdout } = await execFileAsync("find", args, { timeout: 15000, maxBuffer: 1024 * 1024 });
  return stdout.trim() || "No files found matching pattern.";
}

export async function grepToolImpl({ pattern, path, glob, context, case_insensitive }) {
  const target = path || process.env.WORKLAB_WORKSPACE || process.cwd();
  if (!isPathAllowed(target)) return `Error: Path not allowed: ${target}`;
  const args = ["-rn"];
  if (case_insensitive) args.push("-i");
  if (context) args.push(`-C${context}`);
  if (glob) args.push(`--include=${glob}`);
  args.push("--", pattern, target);
  try {
    const { stdout } = await execFileAsync("grep", args, { timeout: 15000, maxBuffer: 1024 * 1024 });
    return stdout || "No matches found.";
  } catch (err) {
    if (err.code === 1) return "No matches found.";
    return `Error: ${err.message}`;
  }
}

export async function bashToolImpl({ command, timeout = 120000 }) {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: process.env.WORKLAB_WORKSPACE || process.cwd(),
      timeout,
      maxBuffer: 5 * 1024 * 1024,
      shell: "/bin/bash",
    });
    if (stdout && stderr) return `STDOUT:\n${stdout}\nSTDERR:\n${stderr}`;
    return stdout || stderr || "(no output)";
  } catch (err) {
    if (err.killed) return `Error: Command timed out after ${timeout}ms`;
    return `Exit code ${err.code || 1}:\n${err.stdout || ""}${err.stderr || err.message}`;
  }
}

export async function webFetchToolImpl({ url, headers = {} }) {
  try { new URL(url); } catch { return "Error: Invalid URL"; }
  try {
    const resp = await fetch(url, { headers: { "User-Agent": "Worklab/0.1", ...headers }, signal: AbortSignal.timeout(15000) });
    const text = await resp.text();
    if (!resp.ok) return `HTTP ${resp.status}: ${text.slice(0, 500)}`;
    return text.length > 100000 ? `${text.slice(0, 100000)}\n... [truncated]` : text;
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
