import { existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { readFileChangeSnapshot, statsForCompletedChange } from "@worklab/agent-runtime/ai/file-change-stats.js";
import { artifactTypeForPath, normalizeArtifactPath, normalizeStoredArtifacts } from "./run-artifacts.js";

const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_MAX_DEPTH = 24;
const DEFAULT_MAX_ARTIFACTS = 500;
const SKIP_DIRS = new Set([
  ".cache",
  ".git",
  ".hg",
  ".next",
  ".pnpm-store",
  ".svn",
  ".turbo",
  ".worklab-tmp",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor",
]);

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function realPath(value) {
  if (!value) return null;
  try {
    return resolve(value);
  } catch {
    return null;
  }
}

function isInsidePath(parent, child) {
  const base = realPath(parent);
  const target = realPath(child);
  if (!base || !target) return false;
  const rel = relative(base, target);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function sortedDirEntries(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function shouldSkipDir(name, absolutePath, { includePath = null } = {}) {
  if (includePath && isInsidePath(absolutePath, includePath)) return false;
  return SKIP_DIRS.has(name);
}

function snapshotFile(path, root) {
  const stat = statSync(path);
  if (!stat.isFile()) return null;
  const contentSnapshot = readFileChangeSnapshot(path);
  const safeContentSnapshot = typeof contentSnapshot.content === "string" && contentSnapshot.content.includes("\0")
    ? {
      exists: contentSnapshot.exists,
      size: contentSnapshot.size,
      line_count: contentSnapshot.line_count,
      unavailable_reason: "binary",
    }
    : contentSnapshot;
  return {
    path,
    relative_path: normalizeArtifactPath(relative(root, path)),
    size_bytes: stat.size,
    mtime_ms: Math.trunc(stat.mtimeMs),
    ...safeContentSnapshot,
  };
}

export function createWorkspaceSnapshot({
  workdir,
  includePath = null,
  maxFiles = DEFAULT_MAX_FILES,
  maxDepth = DEFAULT_MAX_DEPTH,
} = {}) {
  const root = realPath(workdir);
  const files = new Map();
  const diagnostics = {
    scanned: false,
    files: 0,
    truncated: false,
    skipped: [],
  };
  if (!root || !existsSync(root)) return { root, files, diagnostics };

  diagnostics.scanned = true;
  const walk = (dir, depth) => {
    if (diagnostics.truncated || depth > maxDepth) {
      diagnostics.truncated = true;
      return;
    }
    for (const entry of sortedDirEntries(dir)) {
      if (diagnostics.truncated) return;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name, path, { includePath })) {
          diagnostics.skipped.push(normalizeArtifactPath(relative(root, path)));
          continue;
        }
        walk(path, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.size >= maxFiles) {
        diagnostics.truncated = true;
        return;
      }
      try {
        const file = snapshotFile(path, root);
        if (file?.relative_path) files.set(file.relative_path, file);
      } catch {
        // Ignore files that disappear while a worker is running.
      }
    }
  };

  walk(root, 0);
  diagnostics.files = files.size;
  return { root, files, diagnostics };
}

function artifactFromDelta({ file, before = null, kind, workdir, runId, endedAt }) {
  const absolutePath = file?.path || (before?.relative_path ? join(workdir, before.relative_path) : null);
  const normalizedPath = normalizeArtifactPath(absolutePath);
  const relativePath = file?.relative_path || before?.relative_path || normalizeArtifactPath(relative(workdir, absolutePath));
  const lineStats = statsForCompletedChange(
    { path: relativePath, kind },
    before || { exists: false, line_count: 0 },
    file || { exists: false, line_count: 0 },
  ) || {};
  const addedLines = numberOrNull(lineStats.added_lines);
  const removedLines = numberOrNull(lineStats.removed_lines);
  return {
    path: normalizedPath,
    display_path: relativePath,
    kind,
    status: "completed",
    artifact_type: artifactTypeForPath(relativePath, { source: "workspace_delta" }),
    source: "workspace_delta",
    sources: ["workspace_delta"],
    temporary: false,
    size_bytes: numberOrNull(file?.size_bytes ?? before?.size_bytes),
    event_count: 0,
    added_lines: addedLines || 0,
    removed_lines: removedLines || 0,
    has_line_delta: addedLines != null || removedLines != null,
    before_lines: numberOrNull(lineStats.before_lines),
    after_lines: numberOrNull(lineStats.after_lines),
    unavailable_reason: lineStats.unavailable_reason || null,
    hunks: Array.isArray(lineStats.hunks) ? lineStats.hunks : [],
    run_ids: runId ? [runId] : [],
    first_run_id: runId || null,
    last_run_id: runId || null,
    first_seen_at: endedAt || null,
    last_seen_at: endedAt || null,
  };
}

export function collectWorkspaceDeltaArtifacts(beforeSnapshot, {
  workdir,
  runId,
  endedAt = Date.now(),
  maxArtifacts = DEFAULT_MAX_ARTIFACTS,
} = {}) {
  const root = realPath(workdir || beforeSnapshot?.root);
  if (!root) return { artifacts: [], diagnostics: { scanned: false, files: 0, truncated: false } };
  const before = beforeSnapshot?.files instanceof Map ? beforeSnapshot.files : new Map();
  const afterSnapshot = createWorkspaceSnapshot({ workdir: root });
  const artifacts = [];
  const diagnostics = {
    ...afterSnapshot.diagnostics,
    before_files: before.size,
    after_files: afterSnapshot.files.size,
    artifact_limit: maxArtifacts,
    artifact_truncated: false,
  };

  for (const [relativePath, file] of afterSnapshot.files.entries()) {
    const prior = before.get(relativePath);
    const changed = !prior
      || prior.size_bytes !== file.size_bytes
      || prior.mtime_ms !== file.mtime_ms;
    if (!changed) continue;
    artifacts.push(artifactFromDelta({
      file,
      before: prior,
      kind: prior ? "update" : "add",
      workdir: root,
      runId,
      endedAt,
    }));
    if (artifacts.length >= maxArtifacts) {
      diagnostics.artifact_truncated = true;
      break;
    }
  }

  if (!diagnostics.artifact_truncated) {
    for (const [relativePath, prior] of before.entries()) {
      if (afterSnapshot.files.has(relativePath)) continue;
      artifacts.push(artifactFromDelta({
        file: null,
        before: prior,
        kind: "delete",
        workdir: root,
        runId,
        endedAt,
      }));
      if (artifacts.length >= maxArtifacts) {
        diagnostics.artifact_truncated = true;
        break;
      }
    }
  }

  return { artifacts: normalizeStoredArtifacts(artifacts), diagnostics };
}

export function collectQaOutputArtifacts({
  workdir,
  qaOutputDir,
  runId,
  endedAt = Date.now(),
  maxFiles = DEFAULT_MAX_ARTIFACTS,
} = {}) {
  const root = realPath(qaOutputDir);
  if (!root || !existsSync(root)) return { artifacts: [], diagnostics: { scanned: false, files: 0, truncated: false } };
  const snapshot = createWorkspaceSnapshot({
    workdir: root,
    includePath: root,
    maxFiles,
  });
  const artifacts = [];
  for (const file of snapshot.files.values()) {
    const relPath = file.relative_path;
    artifacts.push({
      path: normalizeArtifactPath(file.path),
      display_path: workdir && isInsidePath(workdir, file.path)
        ? normalizeArtifactPath(relative(resolve(workdir), file.path))
        : relPath,
      kind: "add",
      status: "completed",
      artifact_type: "qa_output",
      source: "qa_output_dir",
      sources: ["qa_output_dir"],
      temporary: true,
      size_bytes: file.size_bytes,
      href: `/api/runs/${encodeURIComponent(runId || "")}/artifact-file?path=${encodeURIComponent(relPath)}`,
      artifact_relative_path: relPath,
      event_count: 0,
      added_lines: 0,
      removed_lines: 0,
      has_line_delta: false,
      before_lines: null,
      after_lines: null,
      unavailable_reason: "qa_output",
      hunks: [],
      run_ids: runId ? [runId] : [],
      first_run_id: runId || null,
      last_run_id: runId || null,
      first_seen_at: endedAt || null,
      last_seen_at: endedAt || null,
    });
  }
  return {
    artifacts: normalizeStoredArtifacts(artifacts),
    diagnostics: {
      ...snapshot.diagnostics,
      root,
    },
  };
}

function git(args, cwd) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
  } catch {
    return null;
  }
}

export function captureGitArtifactState(workdir) {
  const root = realPath(workdir);
  if (!root || !existsSync(root)) return { is_repo: false };
  const gitRoot = git(["rev-parse", "--show-toplevel"], root);
  if (!gitRoot) return { is_repo: false };
  return {
    is_repo: true,
    root: gitRoot,
    head: git(["rev-parse", "HEAD"], gitRoot),
    status_short: git(["status", "--short"], gitRoot) || "",
  };
}

export function collectGitArtifacts(before, after, { runId, endedAt = Date.now() } = {}) {
  if (!before?.is_repo || !after?.is_repo || before.root !== after.root) return [];
  if (!before.head || !after.head || before.head === after.head) return [];
  const shortHead = after.head.slice(0, 12);
  return normalizeStoredArtifacts([{
    path: `git/commits/${shortHead}`,
    display_path: `git/commits/${shortHead}`,
    kind: "commit",
    status: "completed",
    artifact_type: "git_commit",
    source: "git",
    sources: ["git"],
    temporary: false,
    size_bytes: null,
    event_count: 0,
    added_lines: 0,
    removed_lines: 0,
    has_line_delta: false,
    before_lines: null,
    after_lines: null,
    unavailable_reason: null,
    hunks: [],
    run_ids: runId ? [runId] : [],
    first_run_id: runId || null,
    last_run_id: runId || null,
    first_seen_at: endedAt || null,
    last_seen_at: endedAt || null,
  }]);
}

export function safeRunArtifactPath(baseDir, requestedPath) {
  const base = realPath(baseDir);
  const requested = String(requestedPath || "").trim();
  if (!base || !requested || isAbsolute(requested) || requested.includes("\0")) return null;
  const target = resolve(base, requested);
  const rel = relative(base, target);
  if (!rel || rel.startsWith("..") || rel.split(sep).includes("..")) return null;
  return target;
}
