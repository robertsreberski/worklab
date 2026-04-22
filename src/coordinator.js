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

export async function startCoordinator({ config = loadConfig() } = {}) {
  const templateDir = join(config.repoRoot, "data-template");
  const seedResult = seedDataFromTemplate({ templateDir, dataDir: config.dataDir });
  if (seedResult.seeded) logger.info("seeded data dir from template");

  const dbPath = join(config.dataDir, "worklab.db");
  const db = getDb(dbPath);

  const { app } = createServer({ db, logger });

  // Serve built UI if present
  const uiDist = join(config.repoRoot, "src/ui/dist");
  if (existsSync(uiDist)) {
    app.use(express.static(uiDist));
    app.get("*", (_req, res) => res.sendFile(join(uiDist, "index.html")));
  } else {
    app.get("/", (_req, res) =>
      res.status(503).send("UI not built. Run: npm run build:ui"),
    );
  }

  const http = createHttpServer(app);
  await new Promise((resolve) => http.listen(config.port, resolve));
  logger.info({ port: config.port }, "coordinator listening");

  // Write pid file
  const pidFile = join(config.dataDir, ".coordinator.pid");
  writeFileSync(pidFile, String(process.pid));

  function shutdown() {
    logger.info("shutdown");
    http.close(() => {
      closeDb();
      try { unlinkSync(pidFile); } catch {}
      process.exit(0);
    });
  }

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  return { http, db, config };
}
