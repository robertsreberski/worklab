import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gracefulStopCoordinator } from "../../cli/service-drain.js";

describe("service drain helper", () => {
  const tempDirs = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempDataDir() {
    const dir = mkdtempSync(join(tmpdir(), "worklab-service-drain-"));
    tempDirs.push(dir);
    return dir;
  }

  it("returns not_running when the coordinator pid file is absent", async () => {
    const result = await gracefulStopCoordinator({ config: { dataDir: tempDataDir() } });
    expect(result.status).toBe("not_running");
  });

  it("removes an invalid stale pid file", async () => {
    const dataDir = tempDataDir();
    const pidFile = join(dataDir, ".coordinator.pid");
    writeFileSync(pidFile, "not-a-pid\n");

    const result = await gracefulStopCoordinator({ config: { dataDir } });

    expect(result.status).toBe("stale_pid");
    expect(existsSync(pidFile)).toBe(false);
  });

  it("returns timed_out when the coordinator stays alive after SIGTERM", async () => {
    const dataDir = tempDataDir();
    const pidFile = join(dataDir, ".coordinator.pid");
    writeFileSync(pidFile, "12345\n");
    vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await gracefulStopCoordinator({
      config: { dataDir, drainTimeoutMs: 0 },
      timeoutMs: 0,
      pollMs: 1,
    });

    expect(result.status).toBe("timed_out");
    expect(readFileSync(pidFile, "utf8")).toBe("12345\n");
  });
});
