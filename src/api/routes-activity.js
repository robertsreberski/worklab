export function registerActivityRoutes(app, { db }) {
  app.get("/api/activity", (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
    const cursor = req.query.cursor ? parseInt(req.query.cursor, 10) : null;
    const filters = [];
    const params = [];
    const from = req.query.from ? Date.parse(req.query.from) || Number(req.query.from) : null;
    const to = req.query.to ? Date.parse(req.query.to) || Number(req.query.to) : null;
    if (cursor) {
      filters.push("r.started_at < ?");
      params.push(cursor);
    }
    if (req.query.agent) {
      filters.push("r.agent_name = ?");
      params.push(req.query.agent);
    }
    if (req.query.status) {
      filters.push("r.status = ?");
      params.push(req.query.status);
    }
    if (from) {
      filters.push("r.started_at >= ?");
      params.push(from);
    }
    if (to) {
      filters.push("r.started_at <= ?");
      params.push(to);
    }
    const cols = `
      r.*,
      t.title AS task_title,
      l.model,
      l.effort,
      l.input_tokens,
      l.output_tokens,
      l.cache_read_tokens,
      l.cache_creation_tokens,
      l.cost_usd,
      l.duration_ms,
      l.num_turns
    `;
    const sql = `SELECT ${cols} FROM task_runs r
      LEFT JOIN tasks t ON t.id = r.task_id
      LEFT JOIN agent_logs l ON l.task_run_id = r.id
      ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
      ORDER BY r.started_at DESC LIMIT ?`;
    const rows = db.prepare(sql).all(...params, limit + 1);
    const items = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? items[items.length - 1].started_at : null;
    res.json({ items, nextCursor });
  });
}
