import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup } from "../../cli/backup.js";
import { launchdPlist, systemdUnit } from "../../cli/install-service.js";

describe("backup command", () => {
  const dirs = [];
  const oldDataDir = process.env.WORKLAB_DATA_DIR;

  afterEach(() => {
    if (oldDataDir === undefined) delete process.env.WORKLAB_DATA_DIR;
    else process.env.WORKLAB_DATA_DIR = oldDataDir;
    vi.restoreAllMocks();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  function tmp(name) {
    const dir = join(tmpdir(), `worklab-${name}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    dirs.push(dir);
    return dir;
  }

  it("creates a local tarball and excludes runtime logs", async () => {
    const dataDir = tmp("backup-data");
    const outDir = tmp("backup-out");
    mkdirSync(join(dataDir, "knowledge"), { recursive: true });
    mkdirSync(join(dataDir, "logs"), { recursive: true });
    writeFileSync(join(dataDir, "knowledge", "note.md"), "hello");
    writeFileSync(join(dataDir, "logs", "worklab.out.log"), "runtime");
    process.env.WORKLAB_DATA_DIR = dataDir;

    const lines = [];
    vi.spyOn(console, "log").mockImplementation((line) => lines.push(String(line)));
    await backup(["--out", outDir]);

    const archive = lines.find((line) => line.startsWith("backup: ")).replace("backup: ", "");
    expect(existsSync(archive)).toBe(true);
    const listing = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" });
    expect(listing).toContain("./knowledge/note.md");
    expect(listing).not.toContain("logs/worklab.out.log");
    expect(lines.find((line) => line.startsWith("restore: "))).toContain(dataDir);
  });
});

describe("service file generators", () => {
  it("renders launchd and systemd units with the Worklab CLI", () => {
    const params = {
      node: "/usr/bin/node",
      cli: "/repo/src/cli/index.js",
      cwd: "/repo",
      dataDir: "/data",
    };

    expect(launchdPlist(params)).toContain("<string>/repo/src/cli/index.js</string>");
    expect(launchdPlist(params)).toContain("<key>KeepAlive</key><true/>");
    expect(systemdUnit(params)).toContain("ExecStart=/usr/bin/node /repo/src/cli/index.js start");
    expect(systemdUnit(params)).toContain("Restart=always");
  });
});
