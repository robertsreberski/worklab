import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareExecenv, teardownExecenv, execenvRoot, execenvBaseDir } from "../../core/execenv.js";

function makeDataDir() {
  return mkdtempSync(join(tmpdir(), "worklab-execenv-"));
}

describe("prepareExecenv", () => {
  it("creates workdir/output/logs subfolders rooted at dataDir/runs/{runId}", () => {
    const dataDir = makeDataDir();
    try {
      const env = prepareExecenv({
        dataDir, runId: "run-123",
        agent: { name: "coder", display_name: "Coder" },
        task: { title: "Demo" },
        providerKind: "claude",
      });
      expect(env.root).toBe(join(dataDir, "runs", "run-123"));
      expect(existsSync(env.workdir)).toBe(true);
      expect(existsSync(env.outputDir)).toBe(true);
      expect(existsSync(env.logsDir)).toBe(true);
      expect(env.runtimeConfigPath).toBeNull();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("does not write native runtime configs for canonical SDK and pi providers", () => {
    const dataDir = makeDataDir();
    try {
      const claude = prepareExecenv({
        dataDir, runId: "run-cli",
        agent: { name: "coder", display_name: "Coder" },
        task: { title: "Implement feature", task_key: "T-1", stage: "execute" },
        providerKind: "claude",
        systemPrompt: "## Role\nyou are a coder",
      });
      const pi = prepareExecenv({
        dataDir, runId: "run-codex",
        agent: { name: "ops", display_name: "Ops" },
        task: { title: "Sweep" },
        providerKind: "pi",
        systemPrompt: "## Capabilities",
      });
      expect(claude.runtimeConfigPath).toBeNull();
      expect(pi.runtimeConfigPath).toBeNull();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("teardownExecenv", () => {
  it("keep=true (default) preserves the directory for inspection", () => {
    const dataDir = makeDataDir();
    try {
      const env = prepareExecenv({
        dataDir, runId: "keep-run",
        agent: { name: "x" }, task: { title: "y" },
        providerKind: "claude",
      });
      teardownExecenv({ dataDir, runId: "keep-run" });
      expect(existsSync(env.root)).toBe(true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("keep=false removes the directory", () => {
    const dataDir = makeDataDir();
    try {
      const env = prepareExecenv({
        dataDir, runId: "rm-run",
        agent: { name: "x" }, task: { title: "y" },
        providerKind: "claude",
      });
      teardownExecenv({ dataDir, runId: "rm-run", keep: false });
      expect(existsSync(env.root)).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("execenv path helpers", () => {
  it("execenvBaseDir / execenvRoot return canonical paths", () => {
    expect(execenvBaseDir("/data")).toBe("/data/runs");
    expect(execenvRoot("/data", "abc")).toBe("/data/runs/abc");
  });

  it("execenvBaseDir requires dataDir", () => {
    expect(() => execenvBaseDir(null)).toThrow();
  });
});
