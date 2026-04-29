import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  homedir: vi.fn(() => "/Users/tester"),
  platform: vi.fn(() => "darwin"),
  userInfo: vi.fn(() => ({ uid: 501 })),
}));

vi.mock("node:child_process", () => ({
  execFileSync: mocks.execFileSync,
}));

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal()),
  homedir: mocks.homedir,
  platform: mocks.platform,
  userInfo: mocks.userInfo,
}));

const {
  configuredNodeFromServiceFile,
  nativeDependencyCheck,
  readTail,
  serviceErrorLogTail,
  serviceRuntimeProblems,
} = await import("../../cli/service-runtime.js");
const { launchdPlist, systemdUnit } = await import("../../cli/install-service.js");

describe("service runtime diagnostics", () => {
  beforeEach(() => {
    mocks.execFileSync.mockReset();
    mocks.platform.mockReturnValue("darwin");
  });

  it("extracts the configured node from generated launchd and systemd files", () => {
    const params = {
      node: "/usr/bin/node",
      cli: "/repo/src/cli/index.js",
      cwd: "/repo",
      dataDir: "/data",
      env: { WORKLAB_DATA_DIR: "/data" },
    };

    expect(configuredNodeFromServiceFile(launchdPlist(params), "darwin")).toBe("/usr/bin/node");
    expect(configuredNodeFromServiceFile(systemdUnit(params), "linux")).toBe("/usr/bin/node");
  });

  it("reports native dependency load failures for the service node", () => {
    const err = Object.assign(new Error("spawn failed"), { stderr: Buffer.from("ABI mismatch") });
    mocks.execFileSync.mockImplementation(() => { throw err; });

    expect(nativeDependencyCheck({ nodePath: "/node", cwd: "/repo" })).toEqual({
      ok: false,
      error: "ABI mismatch",
    });
  });

  it("summarizes service runtime problems", () => {
    const problems = serviceRuntimeProblems({
      installed: true,
      file: "/service.plist",
      configuredNode: "/old/node",
      expectedNode: "/new/node",
      configuredNodeInfo: { ok: true },
      nativeDependency: { ok: false, error: "wrong NODE_MODULE_VERSION" },
    });

    expect(problems).toEqual([
      "service node /old/node differs from current CLI node /new/node",
      "better-sqlite3 cannot load under service node /old/node: wrong NODE_MODULE_VERSION",
    ]);
  });

  it("reads bounded service log tails", () => {
    const dir = mkdtempSync(join(tmpdir(), "worklab-service-runtime-"));
    try {
      mkdirSync(join(dir, "logs"), { recursive: true });
      const log = join(dir, "logs", "worklab.err.log");
      writeFileSync(log, "one\ntwo\nthree\n");
      expect(readTail(log, { maxLines: 2 })).toBe("three");
      expect(serviceErrorLogTail({ dataDir: dir }, { maxLines: 3 })).toBe("two\nthree");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
