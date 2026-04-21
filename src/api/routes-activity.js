export function registerActivityRoutes(app, { db }) {
  app.get("/api/activity", (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
    const cursor = req.query.cursor ? parseInt(req.query.cursor, 10) : null;
    const rows = cursor
      ? db.prepare(
          "SELECT r.*, t.title AS task_title FROM task_runs r JOIN tasks t ON t.id = r.task_id WHERE r.started_at < ? ORDER BY r.started_at DESC LIMIT ?",
        ).all(cursor, limit + 1)
      : db.prepare(
          "SELECT r.*, t.title AS task_title FROM task_runs r JOIN tasks t ON t.id = r.task_id ORDER BY r.started_at DESC LIMIT ?",
        ).all(limit + 1);
    const items = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? items[items.length - 1].started_at : null;
    res.json({ items, nextCursor });
  });
}
