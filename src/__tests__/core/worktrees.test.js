import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectWorktreeSupport,
  prepareRunWorktree,
  reconcileRunWorktree,
} from "../../core/worktrees.js";

const roots = [];

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function makeRepo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "worklab-worktrees-test-")));
  roots.push(root);
  git(root, ["init"]);
  git(root, ["config", "user.email", "worklab@example.test"]);
  git(root, ["config", "user.name", "Worklab Test"]);
  writeFileSync(join(root, "README.md"), "Initial\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "initial"]);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("worktree runtime helpers", () => {
  it("detects Git support and maps project subdirectories into run worktrees", () => {
    const repo = makeRepo();
    mkdirSync(join(repo, "packages", "app"), { recursive: true });
    writeFileSync(join(repo, "packages", "app", "index.js"), "export const app = true;\n");
    git(repo, ["add", "packages/app/index.js"]);
    git(repo, ["commit", "-m", "add app"]);
    const dataDir = mkdtempSync(join(tmpdir(), "worklab-worktrees-data-"));
    roots.push(dataDir);

    const support = inspectWorktreeSupport(join(repo, "packages", "app"));
    expect(support).toMatchObject({
      supported: true,
      clean: true,
      gitRoot: repo,
      relativeWorkdir: "packages/app",
    });

    const prepared = prepareRunWorktree({
      sourceWorkdir: join(repo, "packages", "app"),
      runId: "run-subdir",
      dataDir,
      now: 1234,
    });

    expect(prepared).toMatchObject({
      mode: "worktree",
      source_workdir: join(repo, "packages", "app"),
      source_git_root: repo,
      relative_workdir: "packages/app",
      branch: "worklab/run/run-subdir",
      created_at: 1234,
    });
    expect(prepared.runtime_workdir).toBe(join(dataDir, "runs", "run-subdir", "worktree", "packages", "app"));
    expect(existsSync(prepared.runtime_workdir)).toBe(true);
    expect(readFileSync(join(prepared.runtime_workdir, "index.js"), "utf8")).toContain("app = true");
  });

  it("refuses to prepare a run worktree from a dirty source checkout", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "README.md"), "Dirty\n");
    const dataDir = mkdtempSync(join(tmpdir(), "worklab-worktrees-data-"));
    roots.push(dataDir);

    expect(() => prepareRunWorktree({
      sourceWorkdir: repo,
      runId: "run-dirty",
      dataDir,
    })).toThrow(/source checkout is dirty/);
  });

  it("fast-forwards clean committed AI work back into the source checkout", () => {
    const repo = makeRepo();
    const dataDir = mkdtempSync(join(tmpdir(), "worklab-worktrees-data-"));
    roots.push(dataDir);
    const metadata = prepareRunWorktree({ sourceWorkdir: repo, runId: "run-merge", dataDir });

    writeFileSync(join(metadata.runtime_workdir, "feature.txt"), "AI work\n");
    git(metadata.worktree_root, ["add", "feature.txt"]);
    git(metadata.worktree_root, ["commit", "-m", "add ai feature"]);

    const result = reconcileRunWorktree({ metadata, cleanup: true, now: 2000 });

    expect(result).toMatchObject({ ok: true, status: "merged", merged_at: 2000 });
    expect(readFileSync(join(repo, "feature.txt"), "utf8")).toBe("AI work\n");
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(result.branch_head);
    expect(existsSync(metadata.worktree_root)).toBe(false);
  });

  it("keeps the source checkout unchanged when current source truth conflicts with AI work", () => {
    const repo = makeRepo();
    const dataDir = mkdtempSync(join(tmpdir(), "worklab-worktrees-data-"));
    roots.push(dataDir);
    const metadata = prepareRunWorktree({ sourceWorkdir: repo, runId: "run-conflict", dataDir });

    writeFileSync(join(repo, "README.md"), "Current source truth\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "source update"]);

    writeFileSync(join(metadata.runtime_workdir, "README.md"), "AI branch update\n");
    git(metadata.worktree_root, ["add", "README.md"]);
    git(metadata.worktree_root, ["commit", "-m", "ai update"]);

    const sourceHead = git(repo, ["rev-parse", "HEAD"]);
    const result = reconcileRunWorktree({ metadata, cleanup: true });

    expect(result).toMatchObject({
      ok: false,
      status: "merge_conflict",
      conflict_paths: ["README.md"],
      source_head: sourceHead,
    });
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(sourceHead);
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("Current source truth\n");
    expect(existsSync(metadata.worktree_root)).toBe(true);
  });
});
