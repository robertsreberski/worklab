import express from "express";
import cors from "cors";
import { createSseBroker } from "./sse.js";
import { registerTaskRoutes } from "./routes-tasks.js";
import { registerSettingsRoutes } from "./routes-settings.js";
import { registerActivityRoutes } from "./routes-activity.js";
import { registerRunRoutes } from "./routes-runs.js";
import { registerAgentRoutes } from "./routes-agents.js";
import { registerSkillRoutes } from "./routes-skills.js";
import { registerMcpRoutes } from "./routes-mcp.js";
import { registerKbRoutes } from "./routes-kb.js";
import { registerProviderRoutes } from "./routes-providers.js";
import { registerModelRoutes } from "./routes-models.js";
import { registerSearchRoutes } from "./routes-search.js";

export function createServer({ db, logger, watcher, dataDir, consolidation }) {
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
  registerAgentRoutes(app, { db, broker, consolidation, dataDir });
  if (dataDir) registerSkillRoutes(app, { dataDir });
  if (dataDir) registerMcpRoutes(app, { dataDir });
  if (dataDir) registerKbRoutes(app, { dataDir, broker });
  if (dataDir) registerProviderRoutes(app, { db, dataDir, broker });
  if (dataDir) registerModelRoutes(app, { db, dataDir });
  if (dataDir) registerSearchRoutes(app, { db, dataDir });

  app.use((err, _req, res, _next) => {
    logger?.error?.({ err }, "unhandled error");
    res.status(500).json({ error: { code: "internal", message: err.message } });
  });

  return { app, broker };
}
