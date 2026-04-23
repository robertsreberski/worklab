import { DEFAULT_SETTINGS, readSettings, writeSettings } from "../core/settings.js";

export function registerSettingsRoutes(app, { db, broker, events }) {
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
