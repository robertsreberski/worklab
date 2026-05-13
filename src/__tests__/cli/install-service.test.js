import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const { restartUserService, startUserService } = await import("../../cli/install-service.js");

describe("launchd service controls", () => {
  const tempDirs = [];

  beforeEach(() => {
    mocks.execFileSync.mockReset();
    mocks.homedir.mockReturnValue("/Users/tester");
    mocks.platform.mockReturnValue("darwin");
    mocks.userInfo.mockReturnValue({ uid: 501 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempDataDir() {
    const dir = mkdtempSync(join(tmpdir(), "worklab-service-control-"));
    tempDirs.push(dir);
    return dir;
  }

  it("bootstraps and kickstarts the macOS service on start", async () => {
    mocks.execFileSync.mockImplementation((_cmd, args) => {
      if (args[0] === "bootout") throw new Error("not loaded");
    });

    const result = await startUserService({ config: {} });

    expect(result).toEqual({
      platform: "darwin",
      file: "/Users/tester/Library/LaunchAgents/ai.worklab.plist",
    });
    expect(mocks.execFileSync.mock.calls).toEqual([
      ["launchctl", ["bootout", "gui/501", "/Users/tester/Library/LaunchAgents/ai.worklab.plist"], { stdio: "ignore" }],
      ["launchctl", ["enable", "gui/501/ai.worklab"], { stdio: "ignore" }],
      ["launchctl", ["bootstrap", "gui/501", "/Users/tester/Library/LaunchAgents/ai.worklab.plist"], { stdio: "inherit" }],
      ["launchctl", ["kickstart", "-k", "gui/501/ai.worklab"], { stdio: "inherit" }],
    ]);
  });

  it("bootstraps and kickstarts the macOS service on restart", async () => {
    await restartUserService({ config: {} });

    expect(mocks.execFileSync.mock.calls).toEqual([
      ["launchctl", ["disable", "gui/501/ai.worklab"], { stdio: "ignore" }],
      ["launchctl", ["bootout", "gui/501", "/Users/tester/Library/LaunchAgents/ai.worklab.plist"], { stdio: "ignore" }],
      ["launchctl", ["enable", "gui/501/ai.worklab"], { stdio: "ignore" }],
      ["launchctl", ["bootstrap", "gui/501", "/Users/tester/Library/LaunchAgents/ai.worklab.plist"], { stdio: "inherit" }],
      ["launchctl", ["kickstart", "-k", "gui/501/ai.worklab"], { stdio: "inherit" }],
    ]);
  });

  it("signals the coordinator and waits before bootstrapping the macOS service on restart", async () => {
    const dataDir = tempDataDir();
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, ".coordinator.pid"), "12345\n");
    const calls = [];
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      calls.push(["kill", pid, signal || "0"]);
      if (signal === 0 && calls.filter((call) => call[0] === "kill" && call[2] === "0").length > 1) {
        const err = new Error("not found");
        err.code = "ESRCH";
        throw err;
      }
      return true;
    });
    mocks.execFileSync.mockImplementation((cmd, args, options) => {
      calls.push(["exec", cmd, args, options]);
    });

    await restartUserService({ config: { dataDir, drainTimeoutMs: 100 } });

    expect(calls).toEqual([
      ["exec", "launchctl", ["disable", "gui/501/ai.worklab"], { stdio: "ignore" }],
      ["kill", 12345, "0"],
      ["kill", 12345, "SIGTERM"],
      ["kill", 12345, "0"],
      ["exec", "launchctl", ["bootout", "gui/501", "/Users/tester/Library/LaunchAgents/ai.worklab.plist"], { stdio: "ignore" }],
      ["exec", "launchctl", ["enable", "gui/501/ai.worklab"], { stdio: "ignore" }],
      ["exec", "launchctl", ["bootstrap", "gui/501", "/Users/tester/Library/LaunchAgents/ai.worklab.plist"], { stdio: "inherit" }],
      ["exec", "launchctl", ["kickstart", "-k", "gui/501/ai.worklab"], { stdio: "inherit" }],
    ]);
  });
});
