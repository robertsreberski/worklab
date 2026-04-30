import { spawn } from "node:child_process";
import { join } from "node:path";
import {
  DEFAULT_SETTINGS,
  readRuntimeSettings,
  readSettings,
  runtimeEnvFromValues,
  writeRuntimeSettings,
  writeSettings,
} from "../../core/index.js";
import { serviceStatus } from "../../cli/install-service.js";

function runtimeUnavailable(res) {
  return res.status(501).json({
    error: { code: "not_configured", message: "runtime settings require a loaded Worklab config" },
  });
}

function queueRuntimeRestart({ config, desired }) {
  const cli = join(config.repoRoot, "src", "cli", "index.js");
  const child = spawn(process.execPath, [cli, "restart"], {
    detached: true,
    stdio: "ignore",
    cwd: config.repoRoot,
    env: {
      ...process.env,
      ...runtimeEnvFromValues(desired),
      WORKLAB_DATA_DIR: config.dataDir,
    },
  });
  child.unref();
  return { queued: true, pid: child.pid };
}

export function registerSettingsRoutes(app, { db, broker, events, dataDir, config, runtimeControls = {} }) {
  app.get("/api/settings/runtime", async (_req, res) => {
    if (!config?.dataDir && !dataDir) return runtimeUnavailable(res);
    try {
      const status = runtimeControls.serviceStatus
        ? await runtimeControls.serviceStatus()
        : await serviceStatus();
      res.json({
        runtime: {
          ...readRuntimeSettings({ dataDir: config?.dataDir || dataDir, config }),
          service: status,
        },
      });
    } catch (err) {
      res.status(500).json({ error: { code: "runtime_status_failed", message: err.message } });
    }
  });

  app.patch("/api/settings/runtime", (req, res) => {
    if (!config?.dataDir && !dataDir) return runtimeUnavailable(res);
    try {
      const runtime = writeRuntimeSettings({
        dataDir: config?.dataDir || dataDir,
        config,
        patch: req.body || {},
      });
      broker?.broadcast?.("global", { type: "runtime_settings_updated", keys: Object.keys(req.body || {}) });
      res.json({ runtime });
    } catch (err) {
      res.status(400).json({ error: { code: "validation", message: err.message } });
    }
  });

  app.post("/api/settings/runtime/restart", async (_req, res) => {
    if (!config?.dataDir && !dataDir) return runtimeUnavailable(res);
    try {
      const status = runtimeControls.serviceStatus
        ? await runtimeControls.serviceStatus()
        : await serviceStatus();
      if (!status?.installed) {
        return res.status(409).json({
          error: { code: "service_not_installed", message: "Worklab user service is not installed" },
        });
      }
      const runtime = readRuntimeSettings({ dataDir: config?.dataDir || dataDir, config });
      const queued = runtimeControls.restart
        ? await runtimeControls.restart({ config, desired: runtime.desired })
        : queueRuntimeRestart({ config, desired: runtime.desired });
      const nextRuntime = readRuntimeSettings({ dataDir: config?.dataDir || dataDir, config });
      res.status(202).json({ restart: queued, runtime: { ...nextRuntime, service: status } });
    } catch (err) {
      res.status(500).json({ error: { code: "restart_failed", message: err.message } });
    }
  });

  app.get("/api/settings", (_req, res) => {
    res.json({ settings: readSettings(db) });
  });

  app.patch("/api/settings", (req, res) => {
    const body = req.body || {};
    try {
      const settings = writeSettings(db, body);
      const keys = Object.keys(body);
      broker?.broadcast?.("global", { type: "settings_updated", keys });
      events?.emit?.("settings:updated", { keys, settings });
      res.json({ settings });
    } catch (err) {
      const isUnknown = Object.keys(body).some((key) => !(key in DEFAULT_SETTINGS));
      res.status(400).json({ error: { code: isUnknown ? "validation" : "validation", message: err.message } });
    }
  });
}
