import { DEFAULT_SETTINGS, readSettings, writeSettings } from "../core/settings.js";

export function registerSettingsRoutes(app, { db, broker }) {
  app.get("/api/settings", (_req, res) => {
    res.json({ settings: readSettings(db) });
  });

  app.patch("/api/settings", (req, res) => {
    const body = req.body || {};
    try {
      const settings = writeSettings(db, body);
      broker?.broadcast?.("global", { type: "settings_updated", keys: Object.keys(body) });
      res.json({ settings });
    } catch (err) {
      const isUnknown = Object.keys(body).some((key) => !(key in DEFAULT_SETTINGS));
      res.status(400).json({ error: { code: isUnknown ? "validation" : "validation", message: err.message } });
    }
  });
}
