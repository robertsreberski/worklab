import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  homedir: vi.fn(() => "/Users/tester"),
  platform: vi.fn(() => "darwin"),
  userInfo: vi.fn(() => ({ uid: 501 })),
}));

vi.mock("node:child_process", () => ({
  execFileSync: mocks.execFileSync,
}));

vi.mock("node:os", () => ({
  homedir: mocks.homedir,
  platform: mocks.platform,
  userInfo: mocks.userInfo,
}));

const { restartUserService, startUserService } = await import("../../cli/install-service.js");

describe("launchd service controls", () => {
  beforeEach(() => {
    mocks.execFileSync.mockReset();
    mocks.homedir.mockReturnValue("/Users/tester");
    mocks.platform.mockReturnValue("darwin");
    mocks.userInfo.mockReturnValue({ uid: 501 });
  });

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
      ["launchctl", ["bootstrap", "gui/501", "/Users/tester/Library/LaunchAgents/ai.worklab.plist"], { stdio: "inherit" }],
      ["launchctl", ["enable", "gui/501/ai.worklab"], { stdio: "ignore" }],
      ["launchctl", ["kickstart", "-k", "gui/501/ai.worklab"], { stdio: "inherit" }],
    ]);
  });

  it("bootstraps and kickstarts the macOS service on restart", async () => {
    await restartUserService({ config: {} });

    expect(mocks.execFileSync.mock.calls).toEqual([
      ["launchctl", ["bootout", "gui/501", "/Users/tester/Library/LaunchAgents/ai.worklab.plist"], { stdio: "ignore" }],
      ["launchctl", ["bootstrap", "gui/501", "/Users/tester/Library/LaunchAgents/ai.worklab.plist"], { stdio: "inherit" }],
      ["launchctl", ["enable", "gui/501/ai.worklab"], { stdio: "ignore" }],
      ["launchctl", ["kickstart", "-k", "gui/501/ai.worklab"], { stdio: "inherit" }],
    ]);
  });
});
