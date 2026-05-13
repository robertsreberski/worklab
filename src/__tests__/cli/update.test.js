import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUpdateState } from "../../core/update-check.js";
import {
  buildNpmInstallArgs,
  parseUpdateArgs,
  runPackageUpdate,
} from "../../cli/update.js";

describe("worklab update", () => {
  const tempDirs = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(prefix = "worklab-cli-update-") {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  it("parses check and apply arguments", () => {
    expect(parseUpdateArgs(["--json", "--refresh"])).toEqual({
      apply: false,
      json: true,
      refresh: true,
      version: "",
    });
    expect(parseUpdateArgs(["--apply", "--version", "0.2.0"])).toEqual({
      apply: true,
      json: false,
      refresh: false,
      version: "0.2.0",
    });
    expect(() => parseUpdateArgs(["--apply"])).toThrow(/--version/);
  });

  it("builds a fixed global npm install command for the target package version", () => {
    expect(buildNpmInstallArgs({
      npmCli: "/node/lib/node_modules/npm/bin/npm-cli.js",
      packageName: "@worklab-ai/worklab",
      version: "0.2.0",
    })).toEqual([
      "/node/lib/node_modules/npm/bin/npm-cli.js",
      "install",
      "-g",
      "@worklab-ai/worklab@0.2.0",
    ]);
  });

  it("writes update state, runs npm with the service Node, and restarts the service", async () => {
    const dataDir = tempDir();
    const repoRoot = tempDir();
    const npmCli = join(repoRoot, "node", "lib", "node_modules", "npm", "bin", "npm-cli.js");
    mkdirSync(join(npmCli, ".."), { recursive: true });
    writeFileSync(npmCli, "");
    const execFileSyncImpl = vi.fn();
    const restartImpl = vi.fn(async () => ({ ok: true }));

    await runPackageUpdate({
      config: { dataDir, repoRoot },
      nodePath: "/node/bin/node",
      version: "0.2.0",
      status: {
        package: { name: "@worklab-ai/worklab" },
        install: { npm_cli: npmCli },
      },
      execFileSyncImpl,
      restartImpl,
      now: () => 1000,
    });

    expect(execFileSyncImpl).toHaveBeenCalledWith(
      "/node/bin/node",
      [npmCli, "install", "-g", "@worklab-ai/worklab@0.2.0"],
      expect.objectContaining({ cwd: repoRoot }),
    );
    expect(restartImpl).toHaveBeenCalledWith(["--no-build"]);
    expect(readUpdateState(dataDir).job).toMatchObject({
      status: "succeeded",
      target_version: "0.2.0",
    });
  });
});
