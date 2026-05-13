import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  comparePackageVersions,
  getUpdateStatus,
  resolveInstallMode,
} from "../../core/update-check.js";

describe("npm update checks", () => {
  const tempDirs = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(prefix = "worklab-update-check-") {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  function writePackage(root, pkg = {}) {
    writeFileSync(join(root, "package.json"), JSON.stringify({
      name: "@worklab-ai/worklab",
      version: "0.1.3",
      ...pkg,
    }, null, 2));
  }

  function registryResponse(version) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ name: "@worklab-ai/worklab", version, "dist-tags": { latest: version } }),
    };
  }

  it("compares semver versions without nagging when the local version is newer than npm latest", () => {
    expect(comparePackageVersions("0.1.3", "0.1.2")).toEqual({
      status: "local_newer",
      update_available: false,
    });
    expect(comparePackageVersions("0.1.3", "0.1.3")).toEqual({
      status: "current",
      update_available: false,
    });
    expect(comparePackageVersions("0.1.3", "0.2.0")).toEqual({
      status: "update_available",
      update_available: true,
    });
  });

  it("fetches npm latest, caches the check, and reports unsupported source checkouts", async () => {
    const repoRoot = tempDir();
    const dataDir = tempDir();
    writePackage(repoRoot);
    mkdirSync(join(repoRoot, "src", "ui", "src"), { recursive: true });
    writeFileSync(join(repoRoot, "src", "ui", "vite.config.js"), "export default {};\n");
    const fetchImpl = vi.fn(async () => registryResponse("0.2.0"));

    const first = await getUpdateStatus({
      config: { repoRoot, dataDir },
      fetchImpl,
      now: () => 1000,
    });
    const second = await getUpdateStatus({
      config: { repoRoot, dataDir },
      fetchImpl,
      now: () => 2000,
    });

    expect(first.update_available).toBe(true);
    expect(first.package.current_version).toBe("0.1.3");
    expect(first.package.latest_version).toBe("0.2.0");
    expect(first.install).toMatchObject({
      mode: "source_checkout",
      supported: false,
    });
    expect(second.cache.hit).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("detects global npm package installs using the running Node npm root", () => {
    const root = tempDir();
    const nodePrefix = join(root, "node");
    const nodePath = join(nodePrefix, "bin", "node");
    const npmCli = join(nodePrefix, "lib", "node_modules", "npm", "bin", "npm-cli.js");
    const globalRoot = join(root, "global", "lib", "node_modules");
    const packageRoot = join(globalRoot, "@worklab-ai", "worklab");
    mkdirSync(join(packageRoot, "src", "ui", "dist"), { recursive: true });
    mkdirSync(join(npmCli, ".."), { recursive: true });
    writeFileSync(npmCli, "");
    writePackage(packageRoot);
    const execFileSyncImpl = vi.fn(() => `${globalRoot}\n`);

    const mode = resolveInstallMode({
      repoRoot: packageRoot,
      packageName: "@worklab-ai/worklab",
      nodePath,
      execFileSyncImpl,
    });

    expect(mode).toMatchObject({
      mode: "global_npm",
      supported: true,
      package_root: packageRoot,
      global_root: globalRoot,
      npm_cli: npmCli,
    });
    expect(execFileSyncImpl).toHaveBeenCalledWith(nodePath, [npmCli, "root", "-g"], expect.objectContaining({ encoding: "utf8" }));
  });
});
