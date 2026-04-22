// src/coordinator.js
import { createServer as createHttpServer } from "node:http";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import { createServer } from "./api/server.js";
import { getDb, closeDb } from "./core/db.js";
import { logger } from "./core/logger.js";
import { loadConfig } from "./core/config.js";
import { seedDataFromTemplate } from "./core/first-boot.js";
import { createTaskWatcher } from "./coordinator/task-watcher.js";
import { spawnWorker } from "./coordinator/spawn-worker.js";

export async function startCoordinator({ config = loadConfig() } = {}) {
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
  const { app, broker } = createServer({ db, logger, watcher: watcherProxy, dataDir: config.dataDir });

  watcherHolder.current = createTaskWatcher({
    db, broker, spawn: spawnWorker, workerBinary, logger,
    repoRoot: config.repoRoot, dataDir: config.dataDir,
  });

  const uiDist = join(config.repoRoot, "src/ui/dist");
  if (existsSync(uiDist)) {
    app.use(express.static(uiDist));
    app.get("*", (_req, res) => res.sendFile(join(uiDist, "index.html")));
  } else {
    app.get("/", (_req, res) => res.status(503).send("UI not built. Run: npm run build:ui"));
  }

  const http = createHttpServer(app);
  await new Promise((resolve) => http.listen(config.port, resolve));
  logger.info({ port: config.port }, "coordinator listening");

  const pidFile = join(config.dataDir, ".coordinator.pid");
  writeFileSync(pidFile, String(process.pid));

  async function shutdown() {
    logger.info("shutdown");
    try { await watcherHolder.current.shutdown(); } catch (err) { logger.warn({ err }, "watcher shutdown error"); }
    http.close(() => {
      closeDb();
      try { unlinkSync(pidFile); } catch {}
      process.exit(0);
    });
  }

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  return { http, db, config, watcher: watcherHolder.current };
}
