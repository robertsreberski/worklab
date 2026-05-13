import {
  getUpdateStatus,
  queueUpdateApply,
  updateJobIsActive,
} from "../../core/index.js";

function updateUnavailable(res) {
  return res.status(501).json({
    error: { code: "not_configured", message: "update checks require a loaded Worklab config" },
  });
}

export function registerUpdateRoutes(app, { config, broker, updateControls = {} } = {}) {
  const getStatus = updateControls.getStatus || ((input) => getUpdateStatus(input));
  const queueApply = updateControls.queueApply || ((input) => queueUpdateApply(input));

  app.get("/api/update", async (req, res) => {
    if (!config?.repoRoot || !config?.dataDir) return updateUnavailable(res);
    try {
      const update = await getStatus({ config, refresh: req.query.refresh === "1" || req.query.refresh === "true" });
      res.json({ update });
    } catch (err) {
      res.status(500).json({ error: { code: "update_check_failed", message: err.message } });
    }
  });

  app.post("/api/update/apply", async (req, res) => {
    if (!config?.repoRoot || !config?.dataDir) return updateUnavailable(res);
    try {
      const version = String(req.body?.version || "").trim();
      if (!version) {
        return res.status(400).json({ error: { code: "validation", message: "version is required" } });
      }
      const update = await getStatus({ config, refresh: true });
      if (updateJobIsActive(update.job)) {
        return res.status(409).json({ error: { code: "update_in_progress", message: "an update is already queued or running" } });
      }
      if (!update.install?.supported) {
        return res.status(409).json({ error: { code: "unsupported_install", message: "one-click updates require a global npm package install" } });
      }
      if (!update.update_available) {
        return res.status(409).json({ error: { code: "no_update", message: "no npm update is available" } });
      }
      if (version !== update.package?.latest_version) {
        return res.status(400).json({ error: { code: "version_mismatch", message: "version must match the latest npm version" } });
      }
      const apply = await queueApply({ config, version, update });
      broker?.broadcast?.("global", { type: "update_apply_queued", update: { ...update, job: apply } });
      res.status(202).json({ apply, update });
    } catch (err) {
      res.status(500).json({ error: { code: "update_apply_failed", message: err.message } });
    }
  });
}
