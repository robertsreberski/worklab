const DEFAULTS = {
  consolidation_hour: 3,
  consolidation_enabled: true,
  default_embedding_model: "ollama:nomic-embed-text",
  journal_tail_lines: 80,
  kb_pinned_limit: 10,
  worker_timeout_ms: 1800000,
  cancel_grace_ms: 5000,
};

export function registerSettingsRoutes(app, { db }) {
  function readAll() {
    const rows = db.prepare("SELECT key, value FROM settings").all();
    const out = { ...DEFAULTS };
    for (const row of rows) {
      try { out[row.key] = JSON.parse(row.value); } catch { out[row.key] = row.value; }
    }
    return out;
  }

  app.get("/api/settings", (_req, res) => {
    res.json({ settings: readAll() });
  });

  app.patch("/api/settings", (req, res) => {
    const body = req.body || {};
    const unknown = Object.keys(body).filter(k => !(k in DEFAULTS));
    if (unknown.length) {
      return res.status(400).json({ error: { code: "validation", message: `unknown keys: ${unknown.join(",")}` } });
    }
    const stmt = db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    const tx = db.transaction((entries) => {
      for (const [k, v] of entries) stmt.run(k, JSON.stringify(v));
    });
    tx(Object.entries(body));
    res.json({ settings: readAll() });
  });
}
