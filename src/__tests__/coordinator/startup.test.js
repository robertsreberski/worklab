import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startCoordinator, startDeferredService } from "../../coordinator.js";
import { createAcpProfile } from "../../core/acp-profiles.js";
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

function startupServices(extra = {}) {
  return {
    createTaskWatcher: vi.fn(() => watcherService()),
    createConsolidationManager: vi.fn(() => lifecycleService()),
    createAutomationManager: vi.fn(() => lifecycleService()),
    createTeamLeadCron: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
    startSearchIndexer: vi.fn(() => ({
      shutdown: vi.fn(async () => {}),
      reindexAll: vi.fn(async () => ({ sources: 0, chunks: 0 })),
    })),
    createWorklabPushNotificationService: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
    createWorklabSlackService: vi.fn(() => lifecycleService({
      status: vi.fn(() => ({ enabled: false })),
    })),
    ...extra,
  };
}

function startupConfig(root) {
  return {
    ...loadConfig({
      WORKLAB_PORT: "7878",
      WORKLAB_HOST: "127.0.0.1",
      WORKLAB_DATA_DIR: join(root, "data"),
      WORKLAB_WORKSPACE: join(root, "workspace"),
    }),
    port: 0,
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

  it("wires ACP controls into the server and shuts their operation manager down", async () => {
    const root = mkdtempSync(join(tmpdir(), "worklab-startup-acp-"));
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
    const controls = { probe: vi.fn(async () => ({ ok: true })) };
    const createWorklabAcpControls = vi.fn(() => controls);
    const coordinator = await startCoordinator({
      config,
      optionalStartTimeoutMs: 10,
      services: {
        createWorklabAcpControls,
        createTaskWatcher: vi.fn(() => watcherService()),
        createConsolidationManager: vi.fn(() => lifecycleService()),
        createAutomationManager: vi.fn(() => lifecycleService()),
        createTeamLeadCron: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
        startSearchIndexer: vi.fn(() => ({
          shutdown: vi.fn(async () => {}),
          reindexAll: vi.fn(async () => ({ sources: 0, chunks: 0 })),
        })),
        createWorklabPushNotificationService: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
        createWorklabSlackService: vi.fn(() => lifecycleService({
          status: vi.fn(() => ({ enabled: false })),
        })),
      },
    });
    const operationShutdown = vi.spyOn(coordinator.acpOperationManager, "shutdown");

    expect(createWorklabAcpControls).toHaveBeenCalledWith({
      db: coordinator.db,
      dataDir: config.dataDir,
      urlHandoffAvailable: true,
    });
    expect(coordinator.acpOperationManager.supports("probe")).toBe(true);
    await coordinator.shutdown();
    expect(operationShutdown).toHaveBeenCalledTimes(1);
  });

  it("logs startup phase timings for listener and optional service startup", async () => {
    const root = mkdtempSync(join(tmpdir(), "worklab-startup-timing-"));
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
    const testLogger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };

    const coordinator = await startCoordinator({
      config,
      logger: testLogger,
      optionalStartTimeoutMs: 10,
      services: {
        createTaskWatcher: vi.fn(() => watcherService()),
        createConsolidationManager: vi.fn(() => lifecycleService()),
        createAutomationManager: vi.fn(() => lifecycleService()),
        createTeamLeadCron: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
        startSearchIndexer: vi.fn(() => ({ shutdown: vi.fn(async () => {}), reindexAll: vi.fn(async () => ({ sources: 0, chunks: 0 })) })),
        createWorklabPushNotificationService: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
        createWorklabSlackService: vi.fn(() => lifecycleService({ status: vi.fn(() => ({ enabled: true, connected: true })) })),
      },
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const phases = testLogger.info.mock.calls
        .filter(([, message]) => message === "startup phase complete")
        .map(([payload]) => payload.phase);
      expect(phases).toEqual(expect.arrayContaining([
        "database_ready",
        "http_listen",
        "optional_services_scheduled",
        "consolidation_start",
        "automation_start",
        "team_lead_start",
        "push_notifications_start",
        "slack_start",
        "search_indexer_start",
      ]));
      expect(testLogger.info.mock.calls).toContainEqual([
        expect.objectContaining({ phase: "http_listen", duration_ms: expect.any(Number), since_start_ms: expect.any(Number) }),
        "startup phase complete",
      ]);
    } finally {
      await coordinator.shutdown();
    }
  });

  it("atomically permits only one concurrent coordinator for a data directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "worklab-startup-ownership-race-"));
    roots.push(root);
    const config = startupConfig(root);
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };

    const results = await Promise.allSettled([
      startCoordinator({ config, logger, services: startupServices() }),
      startCoordinator({ config, logger, services: startupServices() }),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason?.message).toContain("Worklab is already running");
    expect(readFileSync(join(config.dataDir, ".coordinator.pid"), "utf8"))
      .toBe(String(process.pid));
    expect(existsSync(join(config.dataDir, ".coordinator.lock"))).toBe(true);

    await fulfilled[0].value.shutdown();
    expect(existsSync(join(config.dataDir, ".coordinator.pid"))).toBe(false);
    expect(existsSync(join(config.dataDir, ".coordinator.lock"))).toBe(true);
  });

  it("rejects same-PID reentry before it can reconcile a live ACP operation", async () => {
    const root = mkdtempSync(join(tmpdir(), "worklab-startup-ownership-acp-"));
    roots.push(root);
    const config = startupConfig(root);
    let releaseProbe;
    const probeGate = new Promise((resolve) => { releaseProbe = resolve; });
    const controls = { probe: vi.fn(async () => probeGate) };
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
    const coordinator = await startCoordinator({
      config,
      logger,
      services: startupServices({ createWorklabAcpControls: vi.fn(() => controls) }),
    });
    try {
      const profile = createAcpProfile({
        db: coordinator.db,
        input: {
          agentName: "ownership-acp",
          displayName: "Ownership ACP",
          command: process.execPath,
          cwd: config.workspace,
        },
      });
      const operation = coordinator.acpOperationManager.start({
        profileId: profile.id,
        kind: "probe",
      });
      await vi.waitFor(() => {
        expect(coordinator.acpOperationManager.get(operation.id)?.state).toBe("running");
      });

      await expect(startCoordinator({
        config: { ...config, port: 0 },
        logger,
        services: startupServices(),
      })).rejects.toThrow("Worklab is already running");
      expect(coordinator.acpOperationManager.get(operation.id)?.state).toBe("running");
      expect(() => coordinator.acpOperationManager.start({
        profileId: profile.id,
        kind: "probe",
      })).toThrow(expect.objectContaining({ code: "operation_active", status: 409 }));

      releaseProbe({ ok: true, status: "ready" });
      await vi.waitFor(() => {
        expect(coordinator.acpOperationManager.get(operation.id)?.state).toBe("succeeded");
      });
    } finally {
      releaseProbe?.({ ok: true, status: "ready" });
      await coordinator.shutdown();
    }
  });

  it("releases its ownership claim when startup fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "worklab-startup-ownership-failure-"));
    roots.push(root);
    const config = startupConfig(root);
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
    await expect(startCoordinator({
      config,
      logger,
      services: startupServices({
        createWorklabPushNotificationService: vi.fn(() => {
          throw new Error("forced startup failure");
        }),
      }),
    })).rejects.toThrow("forced startup failure");
    expect(existsSync(join(config.dataDir, ".coordinator.pid"))).toBe(false);
    expect(existsSync(join(config.dataDir, ".coordinator.lock"))).toBe(true);

    const coordinator = await startCoordinator({
      config,
      logger,
      services: startupServices(),
    });
    await coordinator.shutdown();
  });

  it("does not remove another incarnation's claim during startup failure cleanup", async () => {
    const root = mkdtempSync(join(tmpdir(), "worklab-startup-ownership-identity-"));
    roots.push(root);
    const config = startupConfig(root);
    const pidFile = join(config.dataDir, ".coordinator.pid");
    const replacement = "replacement-incarnation";
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };

    await expect(startCoordinator({
      config,
      logger,
      services: startupServices({
        createWorklabPushNotificationService: vi.fn(() => {
          writeFileSync(pidFile, replacement);
          throw new Error("failure after ownership replacement");
        }),
      }),
    })).rejects.toThrow("failure after ownership replacement");

    expect(readFileSync(pidFile, "utf8")).toBe(replacement);
    expect(existsSync(join(config.dataDir, ".coordinator.lock"))).toBe(true);
  });

  it("reclaims the lifetime lock and stale PID after the owning process is killed", async () => {
    const root = mkdtempSync(join(tmpdir(), "worklab-startup-ownership-crash-"));
    roots.push(root);
    const config = startupConfig(root);
    const pidFile = join(config.dataDir, ".coordinator.pid");
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
    const childScript = `
      const Database = require("better-sqlite3");
      const { mkdirSync, writeFileSync } = require("node:fs");
      const { join } = require("node:path");
      const dataDir = process.env.WORKLAB_LOCK_TEST_DATA_DIR;
      mkdirSync(dataDir, { recursive: true });
      const db = new Database(join(dataDir, ".coordinator.lock"), { timeout: 0 });
      db.pragma("busy_timeout = 0");
      db.exec("BEGIN EXCLUSIVE");
      writeFileSync(join(dataDir, ".coordinator.pid"), String(process.pid), { mode: 0o600 });
      process.stdout.write("ready\\n");
      setInterval(() => {}, 1_000);
    `;
    const child = spawn(process.execPath, ["-e", childScript], {
      cwd: config.repoRoot,
      env: { ...process.env, WORKLAB_LOCK_TEST_DATA_DIR: config.dataDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let coordinator;
    const childExited = new Promise((resolve) => child.once("exit", resolve));
    try {
      await new Promise((resolve, reject) => {
        let stderr = "";
        const timer = setTimeout(() => reject(new Error(`lock child did not become ready: ${stderr}`)), 5_000);
        timer.unref?.();
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          reject(new Error(`lock child exited before ready (${code ?? signal}): ${stderr}`));
        });
        child.stdout.setEncoding("utf8");
        child.stdout.once("data", (chunk) => {
          clearTimeout(timer);
          if (chunk.includes("ready")) resolve();
          else reject(new Error(`unexpected lock child output: ${chunk}`));
        });
      });
      expect(readFileSync(pidFile, "utf8")).toBe(String(child.pid));
      await expect(startCoordinator({
        config,
        logger,
        services: startupServices(),
      })).rejects.toThrow(`Worklab is already running for ${config.dataDir} (pid ${child.pid})`);

      child.kill("SIGKILL");
      await childExited;
      expect(readFileSync(pidFile, "utf8")).toBe(String(child.pid));

      coordinator = await startCoordinator({
        config,
        logger,
        services: startupServices(),
      });
      expect(readFileSync(pidFile, "utf8")).toBe(String(process.pid));
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await childExited;
      }
      await coordinator?.shutdown();
    }
  });
});
