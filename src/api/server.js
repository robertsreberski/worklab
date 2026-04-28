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
import { registerAutomationRoutes } from "./routes-automations.js";
import { registerSlackRoutes } from "./routes-slack.js";
import { registerAdminMcpRoutes } from "../mcp/admin-server.js";

export function createServer({ db, logger, watcher, dataDir, repoRoot, consolidation, automationManager, events, config, runtimeControls, slack }) {
  const app = express();
  const broker = createSseBroker();

  app.use(cors());
  app.use(express.json({ limit: "10mb" }));

  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.get("/api/events/stream", (req, res) => broker.subscribe("global", res));

  registerTaskRoutes(app, { db, broker, logger, watcher, dataDir, repoRoot, config });
  registerSettingsRoutes(app, { db, broker, logger, events, dataDir, config, runtimeControls });
  registerActivityRoutes(app, { db, logger });
  registerRunRoutes(app, { db, broker, dataDir, watcher });
  registerAgentRoutes(app, { db, broker, consolidation, dataDir });
  if (dataDir) registerSkillRoutes(app, { dataDir, db });
  if (dataDir) registerMcpRoutes(app, { dataDir, repoRoot });
  if (dataDir) registerKbRoutes(app, { dataDir, broker, db });
  if (dataDir) registerProviderRoutes(app, { db, dataDir, broker });
  if (dataDir) registerModelRoutes(app, { db, dataDir });
  if (dataDir) registerSearchRoutes(app, { db, dataDir });
  registerAutomationRoutes(app, { db, broker, automationManager });
  registerSlackRoutes(app, { db, config, slack });
  if (config) registerAdminMcpRoutes(app, { config, logger });

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: { code: "not_found", message: "Not found" } });
  });

  app.use((err, _req, res, _next) => {
    logger?.error?.({ err }, "unhandled error");
    res.status(500).json({ error: { code: "internal", message: err.message } });
  });

  return { app, broker };
}
