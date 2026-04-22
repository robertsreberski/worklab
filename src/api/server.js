import express from "express";
import cors from "cors";
import { createSseBroker } from "./sse.js";
import { registerTaskRoutes } from "./routes-tasks.js";
import { registerSettingsRoutes } from "./routes-settings.js";
import { registerActivityRoutes } from "./routes-activity.js";
import { registerRunRoutes } from "./routes-runs.js";
import { registerAgentRoutes } from "./routes-agents.js";

export function createServer({ db, logger, watcher }) {
  const app = express();
  const broker = createSseBroker();

  app.use(cors());
  app.use(express.json({ limit: "10mb" }));

  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.get("/api/events/stream", (req, res) => broker.subscribe("global", res));

  registerTaskRoutes(app, { db, broker, logger, watcher });
  registerSettingsRoutes(app, { db, broker, logger });
  registerActivityRoutes(app, { db, logger });
  registerRunRoutes(app, { db, broker });
  registerAgentRoutes(app, { db, broker });

  app.use((err, _req, res, _next) => {
    logger?.error?.({ err }, "unhandled error");
    res.status(500).json({ error: { code: "internal", message: err.message } });
  });

  return { app, broker };
}
