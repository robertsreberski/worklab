import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const WORKTREE_BRANCH_PREFIX = "worklab/run";
const STATUS_PATHSPEC = [
  "--",
  ".",
  ":(exclude).worklab-tmp/**",
  ":(exclude)**/.worklab-tmp/**",
];

function git(cwd, args, { allowFailure = false } = {}) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    }).trim();
  } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}

function normalizeRelativePath(value) {
  if (!value || value === ".") return "";
  return value.split(sep).join("/");
}

function parseDirtyPaths(statusShort) {
  return String(statusShort || "")
    .split("\n")
    .map((line) => line.replace(/^.. ?/, "").replace(/^.* -> /, "").trim())
    .filter(Boolean)
}

function uniqueSortedPaths(paths) {
  return [...new Set((paths || []).map((path) => String(path || "").trim()).filter(Boolean))].sort();
}

function listChangedPaths(workdir, fromRef, toRef) {
  if (!workdir || !fromRef || !toRef || fromRef === toRef) return [];
  const output = git(workdir, ["diff", "--name-only", `${fromRef}..${toRef}`, ...STATUS_PATHSPEC], { allowFailure: true }) || "";
  return uniqueSortedPaths(output.split("\n"));
}

function intersectPaths(a, b) {
  const right = new Set(b || []);
  return uniqueSortedPaths((a || []).filter((path) => right.has(path)));
}

function sanitizeBranchPart(value) {
  const text = String(value || "").trim().replace(/[^A-Za-z0-9._-]/g, "-");
  if (!text) throw new Error("runId is required for worktree branch creation");
  return text;
}

export function worktreeBranchForRun(runId) {
  return `${WORKTREE_BRANCH_PREFIX}/${sanitizeBranchPart(runId)}`;
}

export function runWorktreeRoot({ dataDir, runId }) {
  if (!dataDir) throw new Error("dataDir is required for worktree mode");
  if (!runId) throw new Error("runId is required for worktree mode");
  return join(resolve(dataDir), "runs", String(runId), "worktree");
}

export function gitStatusShort(workdir) {
  if (!workdir || !existsSync(workdir)) return "";
  return git(workdir, ["status", "--short", "--untracked-files=all", ...STATUS_PATHSPEC], { allowFailure: true }) || "";
}

export function conflictPaths(workdir) {
  const output = git(workdir, ["diff", "--name-only", "--diff-filter=U"], { allowFailure: true }) || "";
  return output.split("\n").map((line) => line.trim()).filter(Boolean).sort();
}

export function inspectRunWorktree({ metadata } = {}) {
  if (!metadata?.worktree_root || !metadata?.source_git_root || !metadata?.branch) {
    return { ok: false, status: "missing_worktree_metadata", metadata };
  }
  if (!existsSync(metadata.worktree_root)) {
    return { ok: false, status: "missing_worktree", metadata };
  }

  const sourceStatus = gitStatusShort(metadata.source_git_root);
  const worktreeStatus = gitStatusShort(metadata.worktree_root);
  const sourceDirtyPaths = parseDirtyPaths(sourceStatus);
  const worktreeDirtyPaths = parseDirtyPaths(worktreeStatus);
  const existingConflicts = conflictPaths(metadata.worktree_root);
  const sourceHead = git(metadata.source_git_root, ["rev-parse", "HEAD"], { allowFailure: true }) || null;
  const branchHead = git(metadata.worktree_root, ["rev-parse", "HEAD"], { allowFailure: true }) || null;
  const baseHead = metadata.base_head || metadata.source_head || null;
  const lastSyncedSourceHead = metadata.source_head || metadata.base_head || null;
  const sourceChangedPaths = listChangedPaths(metadata.source_git_root, lastSyncedSourceHead, sourceHead);
  const worktreeChangedPaths = listChangedPaths(metadata.worktree_root, baseHead, branchHead);
  const sourceDrift = !!(lastSyncedSourceHead && sourceHead && sourceHead !== lastSyncedSourceHead);
  const status = existingConflicts.length
    ? "merge_conflict"
    : sourceDirtyPaths.length
      ? "blocked_dirty_source"
      : worktreeDirtyPaths.length
        ? "blocked_uncommitted_worktree"
        : sourceDrift
          ? "source_drift"
          : "ready";

  return {
    ok: true,
    status,
    source_head: sourceHead,
    branch_head: branchHead,
    base_head: baseHead,
    source_drift: sourceDrift,
    source_changed_paths: sourceChangedPaths,
    worktree_changed_paths: worktreeChangedPaths,
    overlap_paths: intersectPaths(sourceChangedPaths, worktreeChangedPaths),
    dirty_paths: sourceDirtyPaths,
    source_dirty_paths: sourceDirtyPaths,
    worktree_dirty_paths: worktreeDirtyPaths,
    conflict_paths: existingConflicts,
    metadata,
  };
}

export function inspectWorktreeSupport(workdir) {
  const sourceWorkdir = workdir && existsSync(workdir) ? realpathSync(resolve(workdir)) : (workdir ? resolve(workdir) : "");
  if (!sourceWorkdir || !existsSync(sourceWorkdir)) {
    return {
      supported: false,
      reason: "workdir_missing",
      sourceWorkdir: sourceWorkdir || null,
      clean: false,
      dirtyPaths: [],
    };
  }

  const rawGitRoot = git(sourceWorkdir, ["rev-parse", "--show-toplevel"], { allowFailure: true });
  const gitRoot = rawGitRoot && existsSync(rawGitRoot) ? realpathSync(rawGitRoot) : rawGitRoot;
  if (!gitRoot) {
    return {
      supported: false,
      reason: "not_git_repo",
      sourceWorkdir,
      clean: false,
      dirtyPaths: [],
    };
  }

  const relativeWorkdir = normalizeRelativePath(relative(gitRoot, sourceWorkdir));
  if (relativeWorkdir.startsWith("..")) {
    return {
      supported: false,
      reason: "workdir_outside_git_root",
      sourceWorkdir,
      gitRoot,
      clean: false,
      dirtyPaths: [],
    };
  }

  const statusShort = gitStatusShort(gitRoot);
  const head = git(gitRoot, ["rev-parse", "HEAD"], { allowFailure: true });
  return {
    supported: !!head,
    reason: head ? null : "missing_head",
    sourceWorkdir,
    gitRoot,
    relativeWorkdir,
    head: head || null,
    statusShort,
    clean: !statusShort,
    dirtyPaths: parseDirtyPaths(statusShort),
  };
}

export function prepareRunWorktree({
  sourceWorkdir,
  runId,
  dataDir,
  now = Date.now(),
} = {}) {
  const support = inspectWorktreeSupport(sourceWorkdir);
  if (!support.supported) {
    throw new Error(`project workdir does not support Git worktrees: ${support.reason || "unsupported"}`);
  }
  if (!support.clean) {
    throw new Error(`source checkout is dirty: ${support.dirtyPaths.join(", ") || "uncommitted changes"}`);
  }

  const branch = worktreeBranchForRun(runId);
  const existingBranch = git(support.gitRoot, ["show-ref", "--verify", `refs/heads/${branch}`], { allowFailure: true });
  if (existingBranch) throw new Error(`worktree branch already exists: ${branch}`);

  const worktreeRoot = runWorktreeRoot({ dataDir, runId });
  mkdirSync(dirname(worktreeRoot), { recursive: true });
  git(support.gitRoot, ["worktree", "add", "-b", branch, worktreeRoot, support.head]);

  const runtimeWorkdir = support.relativeWorkdir
    ? join(worktreeRoot, support.relativeWorkdir)
    : worktreeRoot;
  return {
    mode: "worktree",
    status: "created",
    branch,
    source_workdir: support.sourceWorkdir,
    source_git_root: support.gitRoot,
    source_head: support.head,
    base_head: support.head,
    worktree_root: worktreeRoot,
    runtime_workdir: runtimeWorkdir,
    relative_workdir: support.relativeWorkdir,
    created_at: now,
  };
}

export function syncRunWorktreeFromSource({
  metadata,
  now = Date.now(),
} = {}) {
  const inspection = inspectRunWorktree({ metadata });
  if (!inspection.ok) return inspection;
  if (inspection.status === "blocked_dirty_source") {
    return { ...inspection, ok: false, dirty_paths: inspection.source_dirty_paths };
  }
  if (inspection.status === "merge_conflict") {
    return { ...inspection, ok: false };
  }
  if (inspection.status === "blocked_uncommitted_worktree") {
    return { ...inspection, ok: false, dirty_paths: inspection.worktree_dirty_paths };
  }

  const previousBranchHead = inspection.branch_head;
  if (!inspection.source_drift) {
    return {
      ...inspection,
      ok: true,
      status: "already_synced",
      previous_branch_head: previousBranchHead,
      synced_at: now,
      metadata: {
        ...metadata,
        status: "already_synced",
        branch_head: previousBranchHead,
        last_sync_status: "already_synced",
        last_sync_at: now,
        last_synced_source_head: inspection.source_head,
        source_changed_paths: inspection.source_changed_paths,
        overlap_paths: inspection.overlap_paths,
      },
    };
  }

  const mergeOutput = git(metadata.worktree_root, ["merge", "--no-edit", inspection.source_head], { allowFailure: true });
  const conflicts = conflictPaths(metadata.worktree_root);
  if (conflicts.length) {
    return {
      ...inspection,
      ok: false,
      status: "merge_conflict",
      conflict_paths: conflicts,
      previous_branch_head: previousBranchHead,
      branch_head: git(metadata.worktree_root, ["rev-parse", "HEAD"], { allowFailure: true }) || previousBranchHead,
      merge_output: mergeOutput || "",
      metadata: {
        ...metadata,
        status: "merge_conflict",
        last_sync_status: "merge_conflict",
        last_sync_at: now,
        last_synced_source_head: inspection.source_head,
        source_changed_paths: inspection.source_changed_paths,
        overlap_paths: inspection.overlap_paths,
        conflict_paths: conflicts,
      },
    };
  }

  const afterMergeStatus = gitStatusShort(metadata.worktree_root);
  if (afterMergeStatus) {
    const dirtyPaths = parseDirtyPaths(afterMergeStatus);
    return {
      ...inspection,
      ok: false,
      status: "blocked_uncommitted_worktree",
      dirty_paths: dirtyPaths,
      worktree_dirty_paths: dirtyPaths,
      previous_branch_head: previousBranchHead,
      branch_head: git(metadata.worktree_root, ["rev-parse", "HEAD"], { allowFailure: true }) || previousBranchHead,
      merge_output: mergeOutput || "",
      metadata: {
        ...metadata,
        status: "blocked_uncommitted_worktree",
        last_sync_status: "blocked_uncommitted_worktree",
        last_sync_at: now,
        last_synced_source_head: inspection.source_head,
        source_changed_paths: inspection.source_changed_paths,
        overlap_paths: inspection.overlap_paths,
        dirty_paths: dirtyPaths,
      },
    };
  }

  const branchHead = git(metadata.worktree_root, ["rev-parse", "HEAD"]);
  return {
    ...inspection,
    ok: true,
    status: "synced",
    source_head: inspection.source_head,
    previous_branch_head: previousBranchHead,
    branch_head: branchHead,
    conflict_paths: [],
    synced_at: now,
    merge_output: mergeOutput || "",
    metadata: {
      ...metadata,
      status: "synced",
      source_head: inspection.source_head,
      branch_head: branchHead,
      last_sync_status: "synced",
      last_sync_at: now,
      last_synced_source_head: inspection.source_head,
      source_changed_paths: inspection.source_changed_paths,
      overlap_paths: inspection.overlap_paths,
      conflict_paths: [],
      synced_at: now,
    },
  };
}

export function reconcileRunWorktree({
  metadata,
  cleanup = true,
  now = Date.now(),
} = {}) {
  const inspection = inspectRunWorktree({ metadata });
  if (!inspection.ok) return inspection;
  if (inspection.status === "blocked_dirty_source") {
    return {
      ...inspection,
      status: "blocked_dirty_source",
      ok: false,
      dirty_paths: inspection.source_dirty_paths,
    };
  }
  if (inspection.status === "merge_conflict") {
    return {
      ...inspection,
      status: "merge_conflict",
      ok: false,
    };
  }
  if (inspection.status === "blocked_uncommitted_worktree") {
    return {
      ...inspection,
      status: "blocked_uncommitted_worktree",
      ok: false,
      dirty_paths: inspection.worktree_dirty_paths,
    };
  }

  let reconcileMetadata = metadata;
  let sourceHead = inspection.source_head;
  if (inspection.source_drift) {
    const sync = syncRunWorktreeFromSource({ metadata, now });
    if (!sync.ok) return sync;
    reconcileMetadata = sync.metadata || metadata;
    sourceHead = sync.source_head;
  }

  const sourceHeadBeforeFf = git(reconcileMetadata.source_git_root, ["rev-parse", "HEAD"]);
  if (sourceHeadBeforeFf !== sourceHead) {
    return {
      ok: false,
      status: "source_moved",
      source_head: sourceHeadBeforeFf,
      expected_source_head: sourceHead,
      metadata: reconcileMetadata,
    };
  }

  const branchHead = git(reconcileMetadata.worktree_root, ["rev-parse", "HEAD"]);
  git(reconcileMetadata.source_git_root, ["merge", "--ff-only", branchHead]);

  let cleaned = false;
  if (cleanup) {
    const removed = git(reconcileMetadata.source_git_root, ["worktree", "remove", "--force", reconcileMetadata.worktree_root], { allowFailure: true });
    cleaned = removed !== null || !existsSync(reconcileMetadata.worktree_root);
  }

  return {
    ok: true,
    status: branchHead === sourceHead ? "already_up_to_date" : "merged",
    source_head: git(metadata.source_git_root, ["rev-parse", "HEAD"]),
    previous_source_head: sourceHead,
    branch_head: branchHead,
    merged_at: now,
    cleaned,
    metadata: {
      ...reconcileMetadata,
      status: branchHead === sourceHead ? "already_up_to_date" : "merged",
      source_head: sourceHead,
      branch_head: branchHead,
      merged_at: now,
      cleaned,
    },
  };
}
