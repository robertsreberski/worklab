import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { argValue, hasFlag } from "./args.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const DEFAULT_SOURCE_DIR = join(repoRoot, "skills", "worklab");
const VALUE_FLAGS = new Set(["--target", "--port", "--host", "--data-dir", "--workspace", "--drain-timeout-ms"]);

function pathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function homeFromEnv(env = process.env) {
  return env.HOME || homedir();
}

function targetHome(target, env = process.env) {
  if (target === "codex") return env.CODEX_HOME || join(homeFromEnv(env), ".codex");
  if (target === "claude") return env.CLAUDE_HOME || join(homeFromEnv(env), ".claude");
  throw new Error(`invalid target: ${target}`);
}

function targetLabel(target) {
  return target === "claude" ? "Claude Code" : "Codex";
}

function canonicalTarget(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "codex") return "codex";
  if (normalized === "claude" || normalized === "claude-code" || normalized === "claude_code") return "claude";
  if (normalized === "all") return "all";
  throw new Error(`invalid target: ${value}; expected codex, claude, or all`);
}

export function normalizeInstallSkillTargets(value) {
  const target = canonicalTarget(value);
  return target === "all" ? ["codex", "claude"] : [target];
}

function assertSkillSource(sourceDir) {
  const source = resolve(sourceDir || DEFAULT_SOURCE_DIR);
  if (!existsSync(join(source, "SKILL.md"))) {
    throw new Error(`worklab skill source is missing SKILL.md: ${source}`);
  }
  return source;
}

function collectFiles(root, prefix = "") {
  const rows = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      rows.push(...collectFiles(fullPath, relativePath));
    } else if (entry.isFile()) {
      rows.push(relativePath);
    } else {
      rows.push(`${relativePath}\0${entry.isSymbolicLink() ? "symlink" : "special"}`);
    }
  }
  return rows.sort();
}

function directoriesMatch(sourceDir, destination) {
  let destinationStat;
  try {
    destinationStat = lstatSync(destination);
  } catch {
    return false;
  }
  if (!destinationStat.isDirectory()) return false;
  const sourceFiles = collectFiles(sourceDir);
  const destinationFiles = collectFiles(destination);
  if (sourceFiles.length !== destinationFiles.length) return false;
  for (let i = 0; i < sourceFiles.length; i += 1) {
    if (sourceFiles[i] !== destinationFiles[i]) return false;
    if (sourceFiles[i].includes("\0")) return false;
    const source = readFileSync(join(sourceDir, sourceFiles[i]));
    const target = readFileSync(join(destination, destinationFiles[i]));
    if (!source.equals(target)) return false;
  }
  return true;
}

function resolvedSymlinkTarget(destination) {
  const linkTarget = readlinkSync(destination);
  return resolve(dirname(destination), linkTarget);
}

function classifyExisting({ destination, sourceDir, mode }) {
  if (!pathExists(destination)) return { exists: false };
  const stat = lstatSync(destination);
  if (stat.isSymbolicLink()) {
    const linkTarget = resolvedSymlinkTarget(destination);
    return {
      exists: true,
      kind: "symlink",
      upToDate: mode === "symlink" && linkTarget === sourceDir,
      linkTarget,
    };
  }
  if (stat.isDirectory()) {
    return {
      exists: true,
      kind: "directory",
      upToDate: mode === "copy" && directoriesMatch(sourceDir, destination),
      matchesSource: directoriesMatch(sourceDir, destination),
    };
  }
  return { exists: true, kind: "file", upToDate: false };
}

function writeInstall({ sourceDir, destination, mode }) {
  mkdirSync(dirname(destination), { recursive: true });
  if (mode === "copy") {
    cpSync(sourceDir, destination, { recursive: true, errorOnExist: true });
  } else {
    symlinkSync(sourceDir, destination, "dir");
  }
}

function installOne({ target, sourceDir, mode, force = false, dryRun = false, env = process.env }) {
  const destination = join(targetHome(target, env), "skills", "worklab");
  const existing = classifyExisting({ destination, sourceDir, mode });
  const base = {
    target,
    label: targetLabel(target),
    source: sourceDir,
    destination,
    mode,
  };

  if (existing.upToDate) {
    return { ...base, action: "up_to_date", wrote: false };
  }

  if (!existing.exists) {
    if (!dryRun) writeInstall({ sourceDir, destination, mode });
    return { ...base, action: dryRun ? "install" : "installed", wrote: !dryRun };
  }

  if (!force) {
    const detail = existing.kind === "directory" && existing.matchesSource && mode === "symlink"
      ? "it is an existing directory matching the source; pass --force to replace it with a symlink"
      : `it already exists as ${existing.kind}; pass --force to replace it`;
    throw new Error(`${targetLabel(target)} Worklab skill already exists at ${destination}; ${detail}`);
  }

  if (!dryRun) {
    rmSync(destination, { recursive: true, force: true });
    writeInstall({ sourceDir, destination, mode });
  }
  return { ...base, action: dryRun ? "replace" : "replaced", wrote: !dryRun };
}

export function installSkill({
  target,
  sourceDir = DEFAULT_SOURCE_DIR,
  mode = "symlink",
  force = false,
  dryRun = false,
  env = process.env,
} = {}) {
  if (!target) throw new Error("install-skill requires --target codex|claude|all");
  if (!["symlink", "copy"].includes(mode)) throw new Error(`invalid install mode: ${mode}`);
  const source = assertSkillSource(sourceDir);
  return normalizeInstallSkillTargets(target).map((resolvedTarget) => installOne({
    target: resolvedTarget,
    sourceDir: source,
    mode,
    force,
    dryRun,
    env,
  }));
}

function firstPositional(args = []) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (VALUE_FLAGS.has(arg)) {
      i += 1;
      continue;
    }
    if (!arg.startsWith("-")) return arg;
  }
  return null;
}

function formatResult(entry) {
  const prefix = entry.wrote ? "" : "[dry-run] ";
  if (entry.action === "up_to_date") {
    return `${entry.label} Worklab skill already up to date at ${entry.destination}`;
  }
  const verb = entry.action === "replaced" || entry.action === "replace"
    ? "Replace"
    : "Install";
  const mode = entry.mode === "copy" ? "copy" : "symlink";
  return `${prefix}${verb} ${entry.label} Worklab skill as ${mode}: ${entry.destination} -> ${entry.source}`;
}

export async function installSkillCli(args = process.argv.slice(3), { env = process.env, stdout = console.log } = {}) {
  const target = argValue(args, "--target") || firstPositional(args);
  const mode = hasFlag(args, "--copy") ? "copy" : "symlink";
  const result = installSkill({
    target,
    mode,
    force: hasFlag(args, "--force"),
    dryRun: hasFlag(args, "--dry-run"),
    env,
  });
  for (const entry of result) stdout(formatResult(entry));
  return result;
}
