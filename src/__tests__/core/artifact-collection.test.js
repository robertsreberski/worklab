import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureGitArtifactState,
  collectGitDiffArtifacts,
  collectQaOutputArtifacts,
  collectWorkspaceDeltaArtifacts,
  createWorkspaceSnapshot,
} from "../../core/artifact-collection.js";

const roots = [];

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "worklab-artifacts-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("artifact collection", () => {
  it("collects non-git workspace deltas without depending on git state", () => {
    const workdir = makeRoot();
    mkdirSync(join(workdir, "src"), { recursive: true });
    writeFileSync(join(workdir, "src", "existing.js"), "export const before = true;\n");
    mkdirSync(join(workdir, ".worklab-tmp"), { recursive: true });
    writeFileSync(join(workdir, ".worklab-tmp", "scratch.txt"), "ignore me\n");

    const before = createWorkspaceSnapshot({ workdir });

    writeFileSync(join(workdir, "src", "existing.js"), "export const after = true;\n");
    writeFileSync(join(workdir, "src", "created.js"), "export const created = true;\n");
    writeFileSync(join(workdir, "report.txt"), "generated report\n");
    writeFileSync(join(workdir, ".worklab-tmp", "scratch.txt"), "still ignored\n");

    const { artifacts, diagnostics } = collectWorkspaceDeltaArtifacts(before, {
      workdir,
      runId: "run-delta",
      endedAt: 1234,
    });

    expect(diagnostics.truncated).toBe(false);
    expect(artifacts.map((artifact) => artifact.display_path || artifact.path).sort()).toEqual([
      "report.txt",
      "src/created.js",
      "src/existing.js",
    ]);
    expect(artifacts.find((artifact) => artifact.path.endsWith("src/existing.js"))).toMatchObject({
      artifact_type: "code_change",
      source: "workspace_delta",
      kind: "update",
      status: "completed",
      last_run_id: "run-delta",
      added_lines: 1,
      removed_lines: 1,
      has_line_delta: true,
    });
    expect(artifacts.find((artifact) => artifact.path.endsWith("src/existing.js"))?.unavailable_reason).toBeNull();
    expect(artifacts.find((artifact) => artifact.path.endsWith("report.txt"))).toMatchObject({
      artifact_type: "generated_output",
      source: "workspace_delta",
      kind: "add",
    });
  });

  it("collects workspace delta hunks for small edited files", () => {
    const workdir = makeRoot();
    mkdirSync(join(workdir, "src"), { recursive: true });
    writeFileSync(join(workdir, "src", "app.js"), "one\ntwo\nthree\n");

    const before = createWorkspaceSnapshot({ workdir });

    writeFileSync(join(workdir, "src", "app.js"), "one\nTWO\nthree\nfour\n");

    const { artifacts } = collectWorkspaceDeltaArtifacts(before, {
      workdir,
      runId: "run-delta",
      endedAt: 1234,
    });

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      display_path: "src/app.js",
      added_lines: 2,
      removed_lines: 1,
      has_line_delta: true,
      unavailable_reason: null,
    });
    expect(artifacts[0].hunks).toEqual([{ start: 2, end: 2 }, { start: 4, end: 4 }]);
  });

  it("collects net line stats from git diff numstat", () => {
    const workdir = makeRoot();
    execFileSync("git", ["init"], { cwd: workdir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "worklab@example.com"], { cwd: workdir });
    execFileSync("git", ["config", "user.name", "Worklab Test"], { cwd: workdir });
    mkdirSync(join(workdir, "src"), { recursive: true });
    writeFileSync(join(workdir, "src", "app.js"), "one\ntwo\nthree\n");
    execFileSync("git", ["add", "."], { cwd: workdir });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: workdir, stdio: "ignore" });

    const before = captureGitArtifactState(workdir);
    writeFileSync(join(workdir, "src", "app.js"), "one\nTWO\nthree\nfour\n");
    writeFileSync(join(workdir, "src", "new.js"), "created\n");
    execFileSync("git", ["add", "."], { cwd: workdir });
    execFileSync("git", ["commit", "-m", "update"], { cwd: workdir, stdio: "ignore" });
    const after = captureGitArtifactState(workdir);

    const artifacts = collectGitDiffArtifacts(before, after, {
      runId: "run-git",
      endedAt: 1234,
    });

    expect(artifacts.map((artifact) => artifact.display_path)).toEqual(["src/app.js", "src/new.js"]);
    expect(artifacts.find((artifact) => artifact.display_path === "src/app.js")).toMatchObject({
      source: "git_diff",
      line_stats_source: "git_diff",
      added_lines: 2,
      removed_lines: 1,
      has_line_delta: true,
      last_run_id: "run-git",
    });
    expect(artifacts.find((artifact) => artifact.display_path === "src/new.js")).toMatchObject({
      added_lines: 1,
      removed_lines: 0,
    });
  });

  it("collects QA output files with safe run artifact links", () => {
    const workdir = makeRoot();
    const qaOutputDir = join(workdir, ".worklab-tmp", "artifacts", "run-qa");
    mkdirSync(qaOutputDir, { recursive: true });
    writeFileSync(join(qaOutputDir, "console.log"), "console output\n");
    mkdirSync(join(qaOutputDir, "snapshots"), { recursive: true });
    writeFileSync(join(qaOutputDir, "snapshots", "page.yml"), "url: http://localhost\n");

    const { artifacts, diagnostics } = collectQaOutputArtifacts({
      workdir,
      qaOutputDir,
      runId: "run-qa",
      endedAt: 2000,
    });

    expect(diagnostics.files).toBe(2);
    expect(artifacts.map((artifact) => artifact.artifact_relative_path).sort()).toEqual([
      "console.log",
      "snapshots/page.yml",
    ]);
    expect(artifacts[0]).toMatchObject({
      artifact_type: "qa_output",
      source: "qa_output_dir",
      temporary: true,
      status: "completed",
      last_run_id: "run-qa",
    });
    expect(artifacts[0].href).toContain("/api/runs/run-qa/artifact-file?path=");
  });
});
