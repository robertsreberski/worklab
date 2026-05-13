import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestServer } from "../helpers/test-server.js";

describe("update routes", () => {
  const dirs = [];

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
  });

  function config() {
    const dataDir = mkdtempSync(join(tmpdir(), "worklab-update-route-"));
    dirs.push(dataDir);
    return {
      dataDir,
      repoRoot: process.cwd(),
      host: "127.0.0.1",
      port: 7878,
      workspace: "/tmp/worklab-workspace",
      logLevel: "info",
    };
  }

  function updateStatus(overrides = {}) {
    return {
      package: {
        name: "@worklab-ai/worklab",
        current_version: "0.1.3",
        latest_version: "0.2.0",
      },
      status: "update_available",
      update_available: true,
      checked_at: "2026-05-13T10:00:00.000Z",
      install: { mode: "global_npm", supported: true },
      job: null,
      ...overrides,
    };
  }

  it("returns update status and honors explicit refresh requests", async () => {
    const getStatus = vi.fn(async ({ refresh }) => updateStatus({ refresh_seen: refresh }));
    const { agent } = makeTestServer({
      config: config(),
      updateControls: { getStatus },
    });

    const res = await agent.get("/api/update?refresh=1").expect(200);

    expect(res.body.update.update_available).toBe(true);
    expect(res.body.update.refresh_seen).toBe(true);
    expect(getStatus).toHaveBeenCalledWith(expect.objectContaining({ refresh: true }));
  });

  it("rejects one-click apply for unsupported install modes", async () => {
    const { agent } = makeTestServer({
      config: config(),
      updateControls: {
        getStatus: async () => updateStatus({ install: { mode: "source_checkout", supported: false } }),
      },
    });

    const res = await agent.post("/api/update/apply").send({ version: "0.2.0" }).expect(409);

    expect(res.body.error.code).toBe("unsupported_install");
  });

  it("queues a detached update for a supported npm install", async () => {
    const queueApply = vi.fn(async () => ({ queued: true, pid: 123, target_version: "0.2.0" }));
    const { agent } = makeTestServer({
      config: config(),
      updateControls: {
        getStatus: async () => updateStatus(),
        queueApply,
      },
    });

    const res = await agent.post("/api/update/apply").send({ version: "0.2.0" }).expect(202);

    expect(res.body.apply).toEqual({ queued: true, pid: 123, target_version: "0.2.0" });
    expect(queueApply).toHaveBeenCalledWith(expect.objectContaining({ version: "0.2.0" }));
  });
});
