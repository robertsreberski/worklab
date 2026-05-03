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
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^.{2}\s+/, "").replace(/^.* -> /, ""));
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

export function reconcileRunWorktree({
  metadata,
  cleanup = true,
  now = Date.now(),
} = {}) {
  if (!metadata?.worktree_root || !metadata?.source_git_root || !metadata?.branch) {
    return { ok: false, status: "missing_worktree_metadata" };
  }
  if (!existsSync(metadata.worktree_root)) {
    return { ok: false, status: "missing_worktree", metadata };
  }

  const sourceStatus = gitStatusShort(metadata.source_git_root);
  if (sourceStatus) {
    return {
      ok: false,
      status: "blocked_dirty_source",
      dirty_paths: parseDirtyPaths(sourceStatus),
      source_head: git(metadata.source_git_root, ["rev-parse", "HEAD"], { allowFailure: true }) || null,
      metadata,
    };
  }

  const existingConflicts = conflictPaths(metadata.worktree_root);
  if (existingConflicts.length) {
    return {
      ok: false,
      status: "merge_conflict",
      conflict_paths: existingConflicts,
      source_head: git(metadata.source_git_root, ["rev-parse", "HEAD"], { allowFailure: true }) || null,
      branch_head: git(metadata.worktree_root, ["rev-parse", "HEAD"], { allowFailure: true }) || null,
      metadata,
    };
  }

  const worktreeStatus = gitStatusShort(metadata.worktree_root);
  if (worktreeStatus) {
    return {
      ok: false,
      status: "blocked_uncommitted_worktree",
      dirty_paths: parseDirtyPaths(worktreeStatus),
      source_head: git(metadata.source_git_root, ["rev-parse", "HEAD"], { allowFailure: true }) || null,
      branch_head: git(metadata.worktree_root, ["rev-parse", "HEAD"], { allowFailure: true }) || null,
      metadata,
    };
  }

  const sourceHead = git(metadata.source_git_root, ["rev-parse", "HEAD"]);
  if (metadata.source_head && sourceHead !== metadata.source_head) {
    const mergeOutput = git(metadata.worktree_root, ["merge", "--no-edit", sourceHead], { allowFailure: true });
    const conflicts = conflictPaths(metadata.worktree_root);
    if (conflicts.length) {
      return {
        ok: false,
        status: "merge_conflict",
        conflict_paths: conflicts,
        source_head: sourceHead,
        branch_head: git(metadata.worktree_root, ["rev-parse", "HEAD"], { allowFailure: true }) || null,
        merge_output: mergeOutput || "",
        metadata,
      };
    }
    const afterMergeStatus = gitStatusShort(metadata.worktree_root);
    if (afterMergeStatus) {
      return {
        ok: false,
        status: "blocked_uncommitted_worktree",
        dirty_paths: parseDirtyPaths(afterMergeStatus),
        source_head: sourceHead,
        branch_head: git(metadata.worktree_root, ["rev-parse", "HEAD"], { allowFailure: true }) || null,
        merge_output: mergeOutput || "",
        metadata,
      };
    }
  }

  const sourceHeadBeforeFf = git(metadata.source_git_root, ["rev-parse", "HEAD"]);
  if (sourceHeadBeforeFf !== sourceHead) {
    return {
      ok: false,
      status: "source_moved",
      source_head: sourceHeadBeforeFf,
      expected_source_head: sourceHead,
      metadata,
    };
  }

  const branchHead = git(metadata.worktree_root, ["rev-parse", "HEAD"]);
  git(metadata.source_git_root, ["merge", "--ff-only", branchHead]);

  let cleaned = false;
  if (cleanup) {
    const removed = git(metadata.source_git_root, ["worktree", "remove", "--force", metadata.worktree_root], { allowFailure: true });
    cleaned = removed !== null || !existsSync(metadata.worktree_root);
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
      ...metadata,
      status: branchHead === sourceHead ? "already_up_to_date" : "merged",
      source_head: sourceHead,
      branch_head: branchHead,
      merged_at: now,
      cleaned,
    },
  };
}
