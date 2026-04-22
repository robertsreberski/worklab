export function registerActivityRoutes(app, { db }) {
  app.get("/api/activity", (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
    const cursor = req.query.cursor ? parseInt(req.query.cursor, 10) : null;
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
    const rows = cursor
      ? db.prepare(
          `SELECT ${cols} FROM task_runs r
           LEFT JOIN tasks t ON t.id = r.task_id
           LEFT JOIN agent_logs l ON l.task_run_id = r.id
           WHERE r.started_at < ?
           ORDER BY r.started_at DESC LIMIT ?`,
        ).all(cursor, limit + 1)
      : db.prepare(
          `SELECT ${cols} FROM task_runs r
           LEFT JOIN tasks t ON t.id = r.task_id
           LEFT JOIN agent_logs l ON l.task_run_id = r.id
           ORDER BY r.started_at DESC LIMIT ?`,
        ).all(limit + 1);
    const items = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? items[items.length - 1].started_at : null;
    res.json({ items, nextCursor });
  });
}
