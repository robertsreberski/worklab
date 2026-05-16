import express from "express";
import cors from "cors";
import { SCHEMA_VERSION } from "../core/db/index.js";
import { readPackageMetadata } from "../core/platform/index.js";
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
import { registerMentionRoutes } from "./routes/mentions.js";
import { registerAttachmentRoutes } from "./routes/attachments.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerAutomationRoutes, registerAutomationWebhookRoutes } from "./routes/automations.js";
import { registerGoalRoutes } from "./routes/goals.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerTeamRoutes } from "./routes/teams.js";
import { registerSlackRoutes } from "./routes/slack.js";
import { registerAssistantRoutes } from "./routes/assistant.js";
import { registerNotificationRoutes } from "./routes/notifications.js";
import { registerUpdateRoutes } from "./routes/update.js";
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

function packageHealth(repoRoot) {
  try {
    const pkg = readPackageMetadata(repoRoot);
    return { name: pkg.name, version: pkg.version };
  } catch {
    return null;
  }
}

function serviceStatusPayload(serviceStatus) {
  try {
    const payload = typeof serviceStatus === "function"
      ? serviceStatus()
      : serviceStatus?.status?.();
    return {
      ok: true,
      ...(payload && typeof payload === "object" ? payload : { services: {} }),
    };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "service_status_failed",
        message: err?.message || "failed to read service status",
      },
      services: {},
    };
  }
}

export function createServer({ db, logger, watcher, dataDir, repoRoot, consolidation, automationManager, events, config, runtimeControls, updateControls, slack, assistant: assistantOptions, notifications, serviceStatus }) {
  const app = express();
  const broker = createSseBroker();

  app.use(cors());
  registerAutomationWebhookRoutes(app, { db, broker, automationManager });
  app.use(express.json({ limit: "10mb" }));
  // SSE drives all freshness for client state. Caching /api responses (browser,
  // service worker, or shared proxy) would risk stale views without buying any
  // bandwidth back, since the data refreshes via the event stream anyway.
  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
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
    package: packageHealth(config?.repoRoot || repoRoot),
  }));
  app.get("/api/services/status", (_req, res) => res.json(serviceStatusPayload(serviceStatus)));
  app.get("/api/events/stream", (req, res) => broker.subscribe("global", res));

  registerProjectRoutes(app, { db, broker, dataDir, config });
  registerTeamRoutes(app, { db, broker, watcher, dataDir });
  registerGoalRoutes(app, { db, broker, watcher });
  registerTaskRoutes(app, { db, broker, logger, watcher, dataDir, repoRoot, config });
  registerSettingsRoutes(app, { db, broker, logger, events, dataDir, config, runtimeControls });
  registerUpdateRoutes(app, { config, broker, updateControls });
  registerActivityRoutes(app, { db, logger });
  registerRunRoutes(app, { db, broker, dataDir, watcher });
  registerAgentRoutes(app, { db, broker, consolidation, dataDir });
  if (dataDir) registerSkillRoutes(app, { dataDir, db });
  if (dataDir) registerMcpRoutes(app, { dataDir, repoRoot, workspace: config?.workspace });
  if (dataDir) registerKbRoutes(app, { dataDir, broker, db });
  if (dataDir) registerProviderRoutes(app, { db, dataDir, broker });
  if (dataDir) registerModelRoutes(app, { db, dataDir });
  if (dataDir) registerSearchRoutes(app, { db, dataDir });
  registerMentionRoutes(app, { db, dataDir });
  registerAttachmentRoutes(app, { db, dataDir });
  registerFileRoutes(app, { db, config });
  registerAutomationRoutes(app, { db, broker, automationManager });
  registerSlackRoutes(app, { db, config, slack });
  registerNotificationRoutes(app, { db, dataDir, notifications });
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
