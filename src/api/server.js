import express from "express";
import cors from "cors";
import { SCHEMA_VERSION } from "../core/index.js";
import { getSchemaVersion, tableExists } from "../core/db/queries/schema.js";
import { createSseBroker } from "./sse.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerActivityRoutes } from "./routes/activity.js";
import { registerRunRoutes } from "./routes/runs.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerSkillRoutes } from "./routes/skills.js";
import { registerMcpRoutes } from "./routes/mcp.js";
import { registerKbRoutes } from "./routes/kb.js";
import { registerProviderRoutes } from "./routes/providers.js";
import { registerModelRoutes } from "./routes/models.js";
import { registerSearchRoutes } from "./routes/search.js";
import { registerAutomationRoutes } from "./routes/automations.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerSlackRoutes } from "./routes/slack.js";
import { registerAssistantRoutes } from "./routes/assistant.js";
import { registerAdminMcpRoutes } from "../mcp/admin/server.js";

const DEFAULT_SLOW_API_MS = 250;

function slowApiThresholdMs() {
  const value = Number(process.env.WORKLAB_SLOW_API_MS || DEFAULT_SLOW_API_MS);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_SLOW_API_MS;
}

function apiTimingMiddleware(logger) {
  const threshold = slowApiThresholdMs();
  return (req, res, next) => {
    if (!logger || threshold === 0 || req.path.endsWith("/stream")) {
      next();
      return;
    }

    const start = process.hrtime.bigint();
    let responseBytes = 0;
    const originalWrite = res.write;
    const originalEnd = res.end;

    res.write = function writeWithSize(chunk, encoding, callback) {
      if (chunk) responseBytes += Buffer.byteLength(chunk, encoding);
      return originalWrite.call(this, chunk, encoding, callback);
    };
    res.end = function endWithSize(chunk, encoding, callback) {
      if (chunk) responseBytes += Buffer.byteLength(chunk, encoding);
      return originalEnd.call(this, chunk, encoding, callback);
    };

    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      if (durationMs < threshold) return;
      logger.warn({
        method: req.method,
        path: req.originalUrl || req.url,
        status: res.statusCode,
        duration_ms: Math.round(durationMs),
        response_bytes: responseBytes,
      }, "slow api request");
    });
    next();
  };
}

export function createServer({ db, logger, watcher, dataDir, repoRoot, consolidation, automationManager, events, config, runtimeControls, slack, assistant: assistantOptions }) {
  const app = express();
  const broker = createSseBroker();

  app.use(cors());
  app.use(express.json({ limit: "10mb" }));
  app.use("/api", apiTimingMiddleware(logger));

  app.get("/api/health", (_req, res) => res.json({
    ok: true,
    pid: process.pid,
    node: process.version,
    uptime_ms: Math.round(process.uptime() * 1000),
    schema: {
      expected: SCHEMA_VERSION,
      actual: getSchemaVersion(db),
    },
    routes: {
      projects: tableExists(db, "projects"),
    },
  }));
  app.get("/api/events/stream", (req, res) => broker.subscribe("global", res));

  registerProjectRoutes(app, { db, broker, config });
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
  const assistant = registerAssistantRoutes(app, { db, broker, logger, config, ...(assistantOptions || {}) });
  if (config) registerAdminMcpRoutes(app, { config, logger });

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: { code: "not_found", message: "Not found" } });
  });

  app.use((err, _req, res, _next) => {
    logger?.error?.({ err }, "unhandled error");
    res.status(500).json({ error: { code: "internal", message: err.message } });
  });

  return { app, broker, assistant };
}
