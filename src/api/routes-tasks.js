import { newTaskId, newCommentId } from "../core/ids.js";

function rowToTask(row) {
  if (!row) return null;
  return {
    ...row,
    tags: JSON.parse(row.tags || "[]"),
    priority: row.priority ?? 0,
    retry_count: row.retry_count ?? 0,
  };
}

export function registerTaskRoutes(app, { db, broker }) {
  app.get("/api/tasks", (req, res) => {
    const rows = db
      .prepare("SELECT * FROM tasks ORDER BY updated_at DESC")
      .all();
    res.json({ tasks: rows.map(rowToTask) });
  });

  app.post("/api/tasks", (req, res) => {
    const { title, description = "", instructions = "", executor_agent = null, reviewer_agent = null, priority = 0, tags = [] } = req.body || {};
    if (!title || typeof title !== "string") {
      return res.status(400).json({ error: { code: "validation", message: "title is required" } });
    }
    const id = newTaskId();
    const now = Date.now();
    db.prepare(`
      INSERT INTO tasks (id, title, description, instructions, executor_agent, reviewer_agent, priority, tags, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, title, description, instructions, executor_agent, reviewer_agent, priority, JSON.stringify(tags), now, now);
    const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    const task = rowToTask(row);
    broker.broadcast("global", { type: "task_created", id });
    res.status(201).json({ task });
  });

  app.get("/api/tasks/:id", (req, res) => {
    const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id);
    if (!row) return res.status(404).json({ error: { code: "not_found", message: "task not found" } });
    const comments = db
      .prepare("SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at")
      .all(req.params.id);
    const runs = db
      .prepare("SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at DESC")
      .all(req.params.id);
    res.json({ task: rowToTask(row), comments, runs });
  });

  const PATCHABLE = ["title", "description", "instructions", "executor_agent", "reviewer_agent", "priority", "tags"];

  app.patch("/api/tasks/:id", (req, res) => {
    const existing = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: { code: "not_found", message: "task not found" } });

    const fields = [];
    const values = [];
    for (const k of PATCHABLE) {
      if (k in req.body) {
        fields.push(`${k} = ?`);
        values.push(k === "tags" ? JSON.stringify(req.body[k] ?? []) : req.body[k]);
      }
    }

    // Status handled in T18 (via state machine). For now, PATCH with only status and no other fields is a no-op.
    if (fields.length === 0 && !("status" in req.body)) {
      return res.json({ task: rowToTask(existing) });
    }

    if (fields.length > 0) {
      fields.push("updated_at = ?");
      values.push(Date.now());
      values.push(req.params.id);
      db.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    }

    const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id);
    broker.broadcast("global", { type: "task_updated", id: req.params.id });
    res.json({ task: rowToTask(row) });
  });
}
