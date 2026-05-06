// src/coordinator.js
import { createServer as createHttpServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { promisify } from "node:util";
import express from "express";
import { createServer } from "./api/server.js";
import {
  closeDb,
  getDb,
  loadConfig,
  logger,
  seedDataFromTemplate,
  seedDefaultAgents,
} from "./core/index.js";
import { createTaskWatcher } from "./coordinator/task-watcher.js";
import { spawnWorker } from "./coordinator/spawn-worker.js";
import { createConsolidationManager } from "./coordinator/consolidation-cron.js";
import { createAutomationManager } from "./coordinator/automation-manager.js";
import { createTeamLeadCron } from "./coordinator/team-lead-cron.js";
import { startSearchIndexer } from "./coordinator/search-indexer.js";
import { createWorklabSlackService } from "./integrations/slack/service.js";
import { createWorklabPushNotificationService } from "./integrations/push/service.js";

const DEFAULT_EVENT_LOOP_WARN_MS = 150;
const DEFAULT_EVENT_LOOP_SAMPLE_MS = 15_000;

function eventLoopWarnThresholdMs() {
  const value = Number(process.env.WORKLAB_EVENT_LOOP_WARN_MS || DEFAULT_EVENT_LOOP_WARN_MS);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_EVENT_LOOP_WARN_MS;
}

function startEventLoopMonitor(logger) {
  const thresholdMs = eventLoopWarnThresholdMs();
  if (!logger || thresholdMs === 0) return { shutdown() {} };
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  const timer = setInterval(() => {
    const p95Ms = histogram.percentile(95) / 1e6;
    const maxMs = histogram.max / 1e6;
    if (p95Ms >= thresholdMs) {
      logger.warn({
        p95_ms: Math.round(p95Ms),
        max_ms: Math.round(maxMs),
        threshold_ms: thresholdMs,
      }, "event loop delay high");
    }
    histogram.reset();
  }, DEFAULT_EVENT_LOOP_SAMPLE_MS);
  timer.unref?.();
  return {
    shutdown() {
      clearInterval(timer);
      histogram.disable();
    },
  };
}

export function createWatcherProxy(watcherHolder) {
  return {
    handleRunRequested: (...args) => watcherHolder.current.handleRunRequested(...args),
    cancel: (...args) => watcherHolder.current.cancel(...args),
    shutdown: (...args) => watcherHolder.current.shutdown(...args),
    isActive: (...args) => watcherHolder.current.isActive(...args),
    getRunLiveInputState: (...args) => watcherHolder.current.getRunLiveInputState(...args),
    sendRunMessage: (...args) => watcherHolder.current.sendRunMessage(...args),
    maybeAutoStart: (...args) => watcherHolder.current.maybeAutoStart(...args),
    maybeAutoStartDependents: (...args) => watcherHolder.current.maybeAutoStartDependents(...args),
    maybeScheduleUnassignedTeamTask: (...args) => watcherHolder.current.maybeScheduleUnassignedTeamTask(...args),
    spawnLeadCycle: (...args) => watcherHolder.current.spawnLeadCycle(...args),
  };
}

export async function startCoordinator({ config = loadConfig() } = {}) {
  mkdirSync(config.dataDir, { recursive: true });
  mkdirSync(config.workspace, { recursive: true });

  const pidFile = join(config.dataDir, ".coordinator.pid");
  if (existsSync(pidFile)) {
    const pid = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    if (Number.isFinite(pid) && pid !== process.pid) {
      try {
        process.kill(pid, 0);
        throw new Error(`Worklab is already running for ${config.dataDir} (pid ${pid})`);
      } catch (err) {
        if (err?.code !== "ESRCH") throw err;
        try { unlinkSync(pidFile); } catch {}
      }
    } else {
      try { unlinkSync(pidFile); } catch {}
    }
  }

  const templateDir = join(config.repoRoot, "data-template");
  const seedResult = seedDataFromTemplate({ templateDir, dataDir: config.dataDir });
  if (seedResult.seeded) logger.info("seeded data dir from template");

  const dbPath = join(config.dataDir, "worklab.db");
  const db = getDb(dbPath);

  // Seed the default planner / executor / reviewer trio if missing. Idempotent —
  // existing rows with the same name are left alone, so users can rename or
  // delete them without re-seeding on every boot.
  const agentSeedResult = seedDefaultAgents({ db, templateDir, logger });
  if (agentSeedResult.seeded > 0) logger.info({ seeded: agentSeedResult.seeded }, "seeded default agents");

  const workerBinary = join(config.repoRoot, "src", "worker.js");

  // Holder pattern: server needs watcher, but watcher needs broker (from server).
  // Use a proxy that dereferences at call time.
  const watcherHolder = { current: null };
  const watcherProxy = createWatcherProxy(watcherHolder);
  const consolidationHolder = { current: null };
  const consolidationProxy = {
    runNow: (...args) => consolidationHolder.current.runNow(...args),
    isActive: (...args) => consolidationHolder.current.isActive(...args),
  };
  const teamLeadCronHolder = { current: null };
  const automationManagerHolder = { current: null };
  const automationManagerProxy = {
    refresh: (...args) => automationManagerHolder.current.refresh(...args),
    tick: (...args) => automationManagerHolder.current.tick(...args),
    runNow: (...args) => automationManagerHolder.current.runNow(...args),
    isActive: (...args) => automationManagerHolder.current.isActive(...args),
  };
  const slackHolder = { current: null };
  const slackProxy = {
    status: (...args) => slackHolder.current?.status?.(...args),
  };
  const events = new EventEmitter();
  const { app, broker } = createServer({
    db,
    logger,
    watcher: watcherProxy,
    dataDir: config.dataDir,
    repoRoot: config.repoRoot,
    consolidation: consolidationProxy,
    automationManager: automationManagerProxy,
    events,
    config,
    slack: slackProxy,
  });

  watcherHolder.current = createTaskWatcher({
    db, broker, spawn: spawnWorker, workerBinary, logger,
    repoRoot: config.repoRoot, dataDir: config.dataDir, workspace: config.workspace,
    runTimeoutMs: config.runTimeoutMs,
    runIdleWarningMs: config.runIdleWarningMs,
    logInlineLimit: config.logInlineLimit,
    events,
  });
  consolidationHolder.current = createConsolidationManager({
    db, broker, spawn: spawnWorker, workerBinary, logger,
    repoRoot: config.repoRoot, dataDir: config.dataDir, config,
    runTimeoutMs: config.runTimeoutMs,
    runIdleWarningMs: config.runIdleWarningMs,
    logInlineLimit: config.logInlineLimit,
  });
  consolidationHolder.current.start();
  automationManagerHolder.current = createAutomationManager({
    db, broker, spawn: spawnWorker, watcher: watcherHolder.current, workerBinary, logger,
    repoRoot: config.repoRoot, dataDir: config.dataDir, workspace: config.workspace,
    runTimeoutMs: config.runTimeoutMs,
    runIdleWarningMs: config.runIdleWarningMs,
    logInlineLimit: config.logInlineLimit,
  });
  automationManagerHolder.current.start();
  teamLeadCronHolder.current = createTeamLeadCron({
    db, watcher: watcherHolder.current, logger,
  });
  teamLeadCronHolder.current.start();
  const searchIndexer = startSearchIndexer({ db, dataDir: config.dataDir, broker, logger, events });
  const eventLoopMonitor = startEventLoopMonitor(logger);
  const pushNotifications = createWorklabPushNotificationService({
    db,
    dataDir: config.dataDir,
    events,
    logger,
  }).start();
  slackHolder.current = createWorklabSlackService({ db, config, logger, events });
  await slackHolder.current.start();

  const uiDist = join(config.repoRoot, "src/ui/dist");
  if (existsSync(uiDist)) {
    app.use(express.static(uiDist));
    app.get("*", (_req, res) => res.sendFile(join(uiDist, "index.html")));
  } else {
    app.get("/", (_req, res) => res.status(503).send("UI not built. Run: npm start or npm run build:ui"));
  }

  const http = createHttpServer(app);
  await new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(config.port, config.host, () => {
      http.off("error", reject);
      resolve();
    });
  });
  logger.info({ host: config.host, port: config.port }, "coordinator listening");

  writeFileSync(pidFile, String(process.pid));

  let shuttingDown = false;
  const closeHttp = promisify(http.close.bind(http));

  // R5: workers may be mid-tool-call when SIGTERM lands. Give them up to
  // `WORKLAB_DRAIN_TIMEOUT_MS` (default 60 s) to wrap up so the next
  // coordinator boot doesn't see them as orphaned. The watchdog still kicks
  // in if a worker is genuinely stuck. The watcher passes the same value
  // into the per-worker drain RPC so the worker-side wrap-up window matches
  // the coordinator-side hang-detection window.
  const drainTimeoutMs = (() => {
    const raw = Number(process.env.WORKLAB_DRAIN_TIMEOUT_MS);
    if (Number.isFinite(raw) && raw > 0) return Math.min(raw, 600_000);
    return 60_000;
  })();

  async function shutdown() {
    if (shuttingDown) {
      logger.warn("shutdown already in progress; forcing exit");
      process.exit(1);
    }
    shuttingDown = true;
    logger.info("shutdown");

    // The watchdog gives the in-process drain a hard ceiling. We give it a
    // little extra slack over `drainTimeoutMs` so the per-worker drain has
    // time to settle (handle cleanup, DB UPDATE, transcript snapshot) before
    // the watchdog forces the process down.
    const watchdogMs = Math.min(600_000, drainTimeoutMs + 10_000);
    const watchdog = setTimeout(() => {
      logger.warn({ drainTimeoutMs, watchdogMs }, "shutdown watchdog fired; forcing exit");
      process.exit(1);
    }, watchdogMs);
    watchdog.unref();

    try { await watcherHolder.current.shutdown({ drainTimeoutMs }); } catch (err) { logger.warn({ err }, "watcher shutdown error"); }
    try { await consolidationHolder.current.shutdown(); } catch (err) { logger.warn({ err }, "consolidation shutdown error"); }
    try { await automationManagerHolder.current.shutdown(); } catch (err) { logger.warn({ err }, "automation manager shutdown error"); }
    try { teamLeadCronHolder.current?.stop?.(); } catch (err) { logger.warn({ err }, "team-lead cron stop error"); }
    try { await searchIndexer.shutdown(); } catch (err) { logger.warn({ err }, "search indexer shutdown error"); }
    try { eventLoopMonitor.shutdown(); } catch (err) { logger.warn({ err }, "event loop monitor shutdown error"); }
    try { pushNotifications.stop(); } catch (err) { logger.warn({ err }, "push notifications shutdown error"); }
    try { await slackHolder.current.shutdown(); } catch (err) { logger.warn({ err }, "slack shutdown error"); }

    try { broker.close(); } catch (err) { logger.warn({ err }, "broker close error"); }
    try { http.closeIdleConnections(); } catch {}
    try { http.closeAllConnections(); } catch {}

    try { await closeHttp(); } catch (err) { logger.warn({ err }, "http close error"); }
    try { closeDb(); } catch (err) { logger.warn({ err }, "db close error"); }
    try { unlinkSync(pidFile); } catch {}

    clearTimeout(watchdog);
    process.exit(0);
  }

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  return {
    http,
    db,
    config,
    watcher: watcherHolder.current,
    consolidation: consolidationHolder.current,
    automationManager: automationManagerHolder.current,
    searchIndexer,
    eventLoopMonitor,
    slack: slackHolder.current,
  };
}
