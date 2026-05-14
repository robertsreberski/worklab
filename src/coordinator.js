// src/coordinator.js
import { createServer as createHttpServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { promisify } from "node:util";
import { createServer } from "./api/server.js";
import {
  closeDb,
  getDb,
} from "./core/db/index.js";
import {
  loadConfig,
  logger as defaultLogger,
  seedDataFromTemplate,
  seedDefaultAgents,
} from "./core/platform/index.js";
import { createTaskWatcher } from "./coordinator/task-watcher.js";
import { spawnWorker } from "./coordinator/spawn-worker.js";
import { createConsolidationManager } from "./coordinator/consolidation-cron.js";
import { createAutomationManager } from "./coordinator/automation-manager.js";
import { createTeamLeadCron } from "./coordinator/team-lead-cron.js";
import { startSearchIndexer } from "./coordinator/search-indexer.js";
import { createWorklabSlackService } from "./integrations/slack/service.js";
import { createWorklabPushNotificationService } from "./integrations/push/service.js";
import { startEventLoopMonitor } from "./coordinator/event-loop-monitor.js";
import { createBackgroundServiceRegistry, startDeferredService } from "./coordinator/service-registry.js";
import { createStartupTimer } from "./coordinator/startup-timer.js";
import { mountStaticUi } from "./coordinator/static-ui.js";
import { createWatcherProxy } from "./coordinator/watcher-proxy.js";

const DEFAULT_OPTIONAL_SERVICE_START_TIMEOUT_MS = 5000;

export { startDeferredService } from "./coordinator/service-registry.js";
export { createWatcherProxy } from "./coordinator/watcher-proxy.js";

export async function startCoordinator({
  config = loadConfig(),
  services = {},
  optionalStartTimeoutMs = DEFAULT_OPTIONAL_SERVICE_START_TIMEOUT_MS,
  logger = defaultLogger,
} = {}) {
  const markStartup = createStartupTimer(logger);
  const deps = {
    createTaskWatcher,
    createConsolidationManager,
    createAutomationManager,
    createTeamLeadCron,
    startSearchIndexer,
    createWorklabSlackService,
    createWorklabPushNotificationService,
    ...services,
  };
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
  markStartup("database_ready", { data_dir: config.dataDir });

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
  const pushNotifications = deps.createWorklabPushNotificationService({
    db,
    dataDir: config.dataDir,
    events,
    logger,
  });
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
    notifications: pushNotifications,
  });

  watcherHolder.current = deps.createTaskWatcher({
    db, broker, spawn: spawnWorker, workerBinary, logger,
    repoRoot: config.repoRoot, dataDir: config.dataDir, workspace: config.workspace,
    runTimeoutMs: config.runTimeoutMs,
    runIdleWarningMs: config.runIdleWarningMs,
    logInlineLimit: config.logInlineLimit,
    events,
  });
  consolidationHolder.current = deps.createConsolidationManager({
    db, broker, spawn: spawnWorker, workerBinary, logger,
    repoRoot: config.repoRoot, dataDir: config.dataDir, config,
    runTimeoutMs: config.runTimeoutMs,
    runIdleWarningMs: config.runIdleWarningMs,
    logInlineLimit: config.logInlineLimit,
  });
  automationManagerHolder.current = deps.createAutomationManager({
    db, broker, spawn: spawnWorker, watcher: watcherHolder.current, workerBinary, logger,
    repoRoot: config.repoRoot, dataDir: config.dataDir, workspace: config.workspace,
    runTimeoutMs: config.runTimeoutMs,
    runIdleWarningMs: config.runIdleWarningMs,
    logInlineLimit: config.logInlineLimit,
  });
  teamLeadCronHolder.current = deps.createTeamLeadCron({
    db, watcher: watcherHolder.current, logger,
  });
  let searchIndexer = { shutdown: async () => {}, reindexAll: async () => ({ skipped: true, reason: "not_started" }) };
  let eventLoopMonitor = { shutdown() {} };
  let optionalServicesStarted = false;
  let optionalServicesHandle = null;
  let backgroundServices = null;
  let shuttingDown = false;

  mountStaticUi(app, { repoRoot: config.repoRoot });

  const http = createHttpServer(app);
  await new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(config.port, config.host, () => {
      http.off("error", reject);
      resolve();
    });
  });
  logger.info({ host: config.host, port: config.port }, "coordinator listening");
  markStartup("http_listen", { host: config.host, port: http.address()?.port || config.port });

  writeFileSync(pidFile, String(process.pid));

  function startOptionalServices() {
    if (optionalServicesStarted || shuttingDown) return;
    optionalServicesStarted = true;
    backgroundServices = createBackgroundServiceRegistry({ logger, markStartup });
    backgroundServices.register({
      name: "consolidation",
      phase: "consolidation_start",
      start: () => consolidationHolder.current.start(),
      shutdown: () => consolidationHolder.current.shutdown(),
      status: () => ({ active: consolidationHolder.current.isActive?.() || false }),
    });
    backgroundServices.register({
      name: "automation",
      phase: "automation_start",
      start: () => automationManagerHolder.current.start(),
      shutdown: () => automationManagerHolder.current.shutdown(),
      status: () => ({ active: automationManagerHolder.current.isActive?.() || false }),
    });
    backgroundServices.register({
      name: "teamLead",
      phase: "team_lead_start",
      start: () => teamLeadCronHolder.current.start(),
      stop: () => teamLeadCronHolder.current?.stop?.(),
    });
    backgroundServices.register({
      name: "eventLoopMonitor",
      phase: "event_loop_monitor_start",
      start: () => {
        eventLoopMonitor = startEventLoopMonitor(logger);
      },
      shutdown: () => eventLoopMonitor.shutdown(),
    });
    backgroundServices.register({
      name: "pushNotifications",
      phase: "push_notifications_start",
      start: () => pushNotifications.start(),
      stop: () => pushNotifications.stop(),
    });
    backgroundServices.register({
      name: "slack",
      phase: "slack_start",
      start: () => {
        slackHolder.current = startDeferredService({
          name: "slack",
          service: deps.createWorklabSlackService({ db, config, logger, events }),
          startTimeoutMs: optionalStartTimeoutMs,
          logger,
        });
      },
      shutdown: () => slackHolder.current?.shutdown?.(),
      status: () => slackHolder.current?.status?.(),
    });
    backgroundServices.register({
      name: "searchIndexer",
      phase: "search_indexer_start",
      start: () => {
        searchIndexer = deps.startSearchIndexer({ db, dataDir: config.dataDir, broker, logger, events });
      },
      shutdown: () => searchIndexer.shutdown(),
      status: () => ({ started: searchIndexer?.reindexAll != null }),
    });
    backgroundServices.startAll();
  }

  optionalServicesHandle = setTimeout(startOptionalServices, 250);
  optionalServicesHandle.unref?.();
  markStartup("optional_services_scheduled");

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

  async function shutdown({ exit = true } = {}) {
    if (shuttingDown) {
      logger.warn("shutdown already in progress; forcing exit");
      if (exit) process.exit(1);
      return { alreadyShuttingDown: true };
    }
    shuttingDown = true;
    process.off("SIGTERM", onSigterm);
    process.off("SIGINT", onSigint);
    logger.info("shutdown");

    // The watchdog gives the in-process drain a hard ceiling. We give it a
    // little extra slack over `drainTimeoutMs` so the per-worker drain has
    // time to settle (handle cleanup, DB UPDATE, transcript snapshot) before
    // the watchdog forces the process down.
    const watchdogMs = Math.min(600_000, drainTimeoutMs + 10_000);
    const watchdog = exit
      ? setTimeout(() => {
        logger.warn({ drainTimeoutMs, watchdogMs }, "shutdown watchdog fired; forcing exit");
        process.exit(1);
      }, watchdogMs)
      : null;
    watchdog?.unref?.();

    if (optionalServicesHandle) clearTimeout(optionalServicesHandle);
    optionalServicesHandle = null;

    try { await watcherHolder.current.shutdown({ drainTimeoutMs }); } catch (err) { logger.warn({ err }, "watcher shutdown error"); }
    if (backgroundServices) {
      await backgroundServices.shutdownAll();
    } else {
      try { await consolidationHolder.current.shutdown(); } catch (err) { logger.warn({ err }, "consolidation shutdown error"); }
      try { await automationManagerHolder.current.shutdown(); } catch (err) { logger.warn({ err }, "automation manager shutdown error"); }
      try { teamLeadCronHolder.current?.stop?.(); } catch (err) { logger.warn({ err }, "team-lead cron stop error"); }
      try { await searchIndexer.shutdown(); } catch (err) { logger.warn({ err }, "search indexer shutdown error"); }
      try { eventLoopMonitor.shutdown(); } catch (err) { logger.warn({ err }, "event loop monitor shutdown error"); }
      try { pushNotifications.stop(); } catch (err) { logger.warn({ err }, "push notifications shutdown error"); }
      try { await slackHolder.current?.shutdown?.(); } catch (err) { logger.warn({ err }, "slack shutdown error"); }
    }

    try { broker.close(); } catch (err) { logger.warn({ err }, "broker close error"); }
    try { http.closeIdleConnections(); } catch {}
    try { http.closeAllConnections(); } catch {}

    try { await closeHttp(); } catch (err) { logger.warn({ err }, "http close error"); }
    try { closeDb(); } catch (err) { logger.warn({ err }, "db close error"); }
    try { unlinkSync(pidFile); } catch {}

    if (watchdog) clearTimeout(watchdog);
    if (exit) process.exit(0);
    return { ok: true };
  }

  const onSigterm = () => shutdown({ exit: true });
  const onSigint = () => shutdown({ exit: true });
  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);

  return {
    http,
    port: http.address()?.port || config.port,
    shutdown: () => shutdown({ exit: false }),
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
