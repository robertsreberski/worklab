import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startCoordinator, startDeferredService } from "../../coordinator.js";
import { loadConfig } from "../../core/config.js";

function lifecycleService(extra = {}) {
  return {
    start: vi.fn(),
    shutdown: vi.fn(async () => {}),
    stop: vi.fn(),
    runNow: vi.fn(),
    refresh: vi.fn(),
    tick: vi.fn(),
    isActive: vi.fn(() => false),
    ...extra,
  };
}

function watcherService() {
  return {
    handleRunRequested: vi.fn(),
    cancel: vi.fn(),
    shutdown: vi.fn(async () => {}),
    isActive: vi.fn(() => false),
    getRunLiveInputState: vi.fn(() => null),
    sendRunMessage: vi.fn(),
    maybeAutoStart: vi.fn(),
    maybeAutoStartDependents: vi.fn(),
    maybeScheduleUnassignedTeamTask: vi.fn(),
    spawnLeadCycle: vi.fn(),
  };
}

describe("coordinator startup services", () => {
  const roots = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not await a never-resolving optional service start", async () => {
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
    const service = {
      start: vi.fn(() => new Promise(() => {})),
      status: vi.fn(() => ({ enabled: true, connected: false, reason: "not_started" })),
      shutdown: vi.fn(async () => {}),
    };

    const started = startDeferredService({
      name: "slack",
      service,
      startTimeoutMs: 10,
      logger,
    });

    expect(service.start).toHaveBeenCalledTimes(1);
    expect(started.status()).toMatchObject({
      enabled: true,
      connected: false,
      reason: "starting",
    });

    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(started.status()).toMatchObject({
      enabled: true,
      connected: false,
      reason: "start_timeout",
    });
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ service: "slack" }), "optional service start timed out");
  });

  it("serves health before optional integrations finish starting", async () => {
    const root = mkdtempSync(join(tmpdir(), "worklab-startup-"));
    roots.push(root);
    const config = {
      ...loadConfig({
        WORKLAB_PORT: "7878",
        WORKLAB_HOST: "127.0.0.1",
        WORKLAB_DATA_DIR: join(root, "data"),
        WORKLAB_WORKSPACE: join(root, "workspace"),
      }),
      port: 0,
    };
    const slack = {
      start: vi.fn(() => new Promise(() => {})),
      status: vi.fn(() => ({ enabled: true, connected: false, reason: "not_started" })),
      shutdown: vi.fn(async () => {}),
    };

    const coordinator = await Promise.race([
      startCoordinator({
        config,
        optionalStartTimeoutMs: 10,
        services: {
          createTaskWatcher: vi.fn(() => watcherService()),
          createConsolidationManager: vi.fn(() => lifecycleService()),
          createAutomationManager: vi.fn(() => lifecycleService()),
          createTeamLeadCron: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
          startSearchIndexer: vi.fn(() => ({ shutdown: vi.fn(async () => {}), reindexAll: vi.fn(async () => ({ sources: 0, chunks: 0 })) })),
          createWorklabPushNotificationService: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
          createWorklabSlackService: vi.fn(() => slack),
        },
      }),
      new Promise((resolve) => setTimeout(() => resolve(null), 1000)),
    ]);

    expect(coordinator).toBeTruthy();
    try {
      const res = await fetch(`http://127.0.0.1:${coordinator.port}/api/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true });
    } finally {
      await coordinator?.shutdown?.();
    }
  });
});
