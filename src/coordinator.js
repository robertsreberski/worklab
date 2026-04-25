// src/coordinator.js
import { createServer as createHttpServer } from "node:http";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { promisify } from "node:util";
import express from "express";
import { createServer } from "./api/server.js";
import { getDb, closeDb } from "./core/db.js";
import { logger } from "./core/logger.js";
import { loadConfig } from "./core/config.js";
import { seedDataFromTemplate } from "./core/first-boot.js";
import { createTaskWatcher } from "./coordinator/task-watcher.js";
import { spawnWorker } from "./coordinator/spawn-worker.js";
import { createConsolidationManager } from "./coordinator/consolidation-cron.js";
import { createScheduleManager } from "./coordinator/schedule-manager.js";
import { startSearchIndexer } from "./coordinator/search-indexer.js";

export async function startCoordinator({ config = loadConfig() } = {}) {
  mkdirSync(config.workspace, { recursive: true });

  const templateDir = join(config.repoRoot, "data-template");
  const seedResult = seedDataFromTemplate({ templateDir, dataDir: config.dataDir });
  if (seedResult.seeded) logger.info("seeded data dir from template");

  const dbPath = join(config.dataDir, "worklab.db");
  const db = getDb(dbPath);

  const workerBinary = join(config.repoRoot, "src", "worker.js");

  // Holder pattern: server needs watcher, but watcher needs broker (from server).
  // Use a proxy that dereferences at call time.
  const watcherHolder = { current: null };
  const watcherProxy = {
    handleRunRequested: (...args) => watcherHolder.current.handleRunRequested(...args),
    cancel: (...args) => watcherHolder.current.cancel(...args),
    shutdown: (...args) => watcherHolder.current.shutdown(...args),
    isActive: (...args) => watcherHolder.current.isActive(...args),
  };
  const consolidationHolder = { current: null };
  const consolidationProxy = {
    runNow: (...args) => consolidationHolder.current.runNow(...args),
    isActive: (...args) => consolidationHolder.current.isActive(...args),
  };
  const scheduleManagerHolder = { current: null };
  const scheduleManagerProxy = {
    refresh: (...args) => scheduleManagerHolder.current.refresh(...args),
    tick: (...args) => scheduleManagerHolder.current.tick(...args),
  };
  const events = new EventEmitter();
  const { app, broker } = createServer({
    db,
    logger,
    watcher: watcherProxy,
    dataDir: config.dataDir,
    repoRoot: config.repoRoot,
    consolidation: consolidationProxy,
    scheduleManager: scheduleManagerProxy,
    events,
  });

  watcherHolder.current = createTaskWatcher({
    db, broker, spawn: spawnWorker, workerBinary, logger,
    repoRoot: config.repoRoot, dataDir: config.dataDir, workspace: config.workspace,
  });
  consolidationHolder.current = createConsolidationManager({
    db, broker, spawn: spawnWorker, workerBinary, logger,
    repoRoot: config.repoRoot, dataDir: config.dataDir, config,
  });
  consolidationHolder.current.start();
  scheduleManagerHolder.current = createScheduleManager({ db, broker, logger });
  scheduleManagerHolder.current.start();
  const searchIndexer = startSearchIndexer({ db, dataDir: config.dataDir, broker, logger, events });

  const uiDist = join(config.repoRoot, "src/ui/dist");
  if (existsSync(uiDist)) {
    app.use(express.static(uiDist));
    app.get("*", (_req, res) => res.sendFile(join(uiDist, "index.html")));
  } else {
    app.get("/", (_req, res) => res.status(503).send("UI not built. Run: npm start or npm run build:ui"));
  }

  const http = createHttpServer(app);
  await new Promise((resolve) => http.listen(config.port, resolve));
  logger.info({ port: config.port }, "coordinator listening");

  const pidFile = join(config.dataDir, ".coordinator.pid");
  writeFileSync(pidFile, String(process.pid));

  let shuttingDown = false;
  const closeHttp = promisify(http.close.bind(http));

  async function shutdown() {
    if (shuttingDown) {
      logger.warn("shutdown already in progress; forcing exit");
      process.exit(1);
    }
    shuttingDown = true;
    logger.info("shutdown");

    const watchdog = setTimeout(() => {
      logger.warn("shutdown watchdog fired; forcing exit");
      process.exit(1);
    }, 5000);
    watchdog.unref();

    try { await watcherHolder.current.shutdown(); } catch (err) { logger.warn({ err }, "watcher shutdown error"); }
    try { await consolidationHolder.current.shutdown(); } catch (err) { logger.warn({ err }, "consolidation shutdown error"); }
    try { await scheduleManagerHolder.current.shutdown(); } catch (err) { logger.warn({ err }, "schedule manager shutdown error"); }
    try { await searchIndexer.shutdown(); } catch (err) { logger.warn({ err }, "search indexer shutdown error"); }

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
    scheduleManager: scheduleManagerHolder.current,
    searchIndexer,
  };
}
