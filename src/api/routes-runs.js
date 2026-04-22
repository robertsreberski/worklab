export function registerRunRoutes(app, { db, broker }) {
  app.get("/api/runs/:id", (req, res) => {
    const run = db.prepare("SELECT * FROM task_runs WHERE id = ?").get(req.params.id);
    if (!run) return res.status(404).json({ error: { code: "not_found", message: "run not found" } });
    const logRow = db.prepare("SELECT * FROM agent_logs WHERE task_run_id = ?").get(req.params.id);
    const log = logRow ? { ...logRow, events: JSON.parse(logRow.events || "[]") } : null;
    res.json({ run, log });
  });

  app.get("/api/runs/:id/stream", (req, res) => {
    broker.subscribe(req.params.id, res);
  });
}
