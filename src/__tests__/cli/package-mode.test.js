import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureUiReady } from "../../cli/start.js";

describe("packaged UI startup mode", () => {
  const tempDirs = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function repoRoot() {
    const dir = mkdtempSync(join(tmpdir(), "worklab-package-mode-"));
    tempDirs.push(dir);
    return dir;
  }

  function writeSourceUi(root) {
    mkdirSync(join(root, "src", "ui", "src"), { recursive: true });
    writeFileSync(join(root, "src", "ui", "vite.config.js"), "export default {};\n");
  }

  function writeBundledUi(root) {
    mkdirSync(join(root, "src", "ui", "dist"), { recursive: true });
    writeFileSync(join(root, "src", "ui", "dist", "index.html"), "<!doctype html>\n");
  }

  it("builds the UI when source build inputs are present", () => {
    const root = repoRoot();
    writeSourceUi(root);
    const build = vi.fn();
    const log = vi.fn();

    const result = ensureUiReady({ repoRoot: root }, { build, log });

    expect(result).toEqual({ action: "build", reason: "source-ui" });
    expect(build).toHaveBeenCalledWith({ repoRoot: root });
    expect(log).not.toHaveBeenCalled();
  });

  it("uses bundled UI assets when source build inputs are absent", () => {
    const root = repoRoot();
    writeBundledUi(root);
    const build = vi.fn();
    const log = vi.fn();

    const result = ensureUiReady({ repoRoot: root }, { build, log });

    expect(result).toEqual({ action: "skip", reason: "bundled-ui" });
    expect(build).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("build: skipped (using bundled UI)");
  });

  it("fails before service install when a packaged install is missing bundled UI assets", () => {
    const root = repoRoot();

    expect(() => ensureUiReady({ repoRoot: root }, { build: vi.fn(), log: vi.fn() }))
      .toThrow(/Worklab UI assets are missing/);
  });

  it("honors explicit build skips", () => {
    const root = repoRoot();
    const build = vi.fn();
    const log = vi.fn();

    const result = ensureUiReady({ repoRoot: root }, { skipBuild: true, build, log });

    expect(result).toEqual({ action: "skip", reason: "flag" });
    expect(build).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("build: skipped");
  });
});
