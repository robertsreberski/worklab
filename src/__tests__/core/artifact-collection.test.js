import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
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
    });
    expect(artifacts.find((artifact) => artifact.path.endsWith("report.txt"))).toMatchObject({
      artifact_type: "generated_output",
      source: "workspace_delta",
      kind: "add",
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
