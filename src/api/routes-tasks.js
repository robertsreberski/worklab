import { newTaskId, newCommentId } from "../core/ids.js";
import { nextStatus, STATUSES } from "../core/state-machine.js";

const RUNS_ORDER_BY = "ORDER BY r.started_at DESC, r.rowid DESC";

function rowToTask(row) {
  if (!row) return null;
  return {
    ...row,
    tags: JSON.parse(row.tags || "[]"),
    retry_count: row.retry_count ?? 0,
    source_schedule_id: row.source_schedule_id || null,
  };
}

function compactTaskSummary(row) {
  const task = rowToTask(row);
  if (!task) return null;
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    updated_at: task.updated_at,
    executor_agent: task.executor_agent,
    reviewer_agent: task.reviewer_agent,
    source_schedule_id: task.source_schedule_id,
  };
}

// §9.3 derived fields.
// `running_run_id` — latest task_runs row where status='running', or null.
// `last_run` — latest completed run summary (id, status, ended_at) for §5.3
//              error-chip policy.
function attachDerivedRunFields(db, task) {
  if (!task) return task;
  const runningRow = db.prepare(
    `SELECT id FROM task_runs
     WHERE task_id = ? AND status = 'running'
     ORDER BY started_at DESC LIMIT 1`
  ).get(task.id);
  const lastRow = db.prepare(
    `SELECT id, status, ended_at FROM task_runs
     WHERE task_id = ? AND status <> 'running'
     ORDER BY started_at DESC LIMIT 1`
  ).get(task.id);
  return {
    ...task,
    running_run_id: runningRow?.id || null,
    last_run: lastRow ? { id: lastRow.id, status: lastRow.status, ended_at: lastRow.ended_at } : null,
  };
}

function directDependencyRows(db, taskId) {
  return db.prepare(`
    SELECT t.*
    FROM task_dependencies d
    JOIN tasks t ON t.id = d.depends_on_task_id
    WHERE d.task_id = ?
    ORDER BY t.updated_at DESC, t.rowid DESC
  `).all(taskId);
}

function directDependentRows(db, taskId) {
  return db.prepare(`
    SELECT t.*
    FROM task_dependencies d
    JOIN tasks t ON t.id = d.task_id
    WHERE d.depends_on_task_id = ?
    ORDER BY t.updated_at DESC, t.rowid DESC
  `).all(taskId);
}

function attachTaskGraph(db, task) {
  if (!task) return task;
  const dependencyRows = directDependencyRows(db, task.id);
  const dependentRows = directDependentRows(db, task.id);
  return {
    ...task,
    dependency_ids: dependencyRows.map((row) => row.id),
    blocked_by: dependencyRows.map(compactTaskSummary),
    blocks: dependentRows.map(compactTaskSummary),
  };
}

function enrichTask(db, task) {
  return attachTaskGraph(db, attachDerivedRunFields(db, task));
}

function normaliseDependencyIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry) => typeof entry === "string" && entry.trim().length > 0))];
}

function pathExists(db, startId, targetId, seen = new Set()) {
  if (startId === targetId) return true;
  if (seen.has(startId)) return false;
  seen.add(startId);
  const rows = db.prepare("SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?").all(startId);
  for (const row of rows) {
    if (pathExists(db, row.depends_on_task_id, targetId, seen)) return true;
  }
  return false;
}

function validateDependencyIds(db, taskId, dependencyIds) {
  const ids = normaliseDependencyIds(dependencyIds);
  for (const dependencyId of ids) {
    if (taskId && dependencyId === taskId) {
      throw Object.assign(new Error("a task cannot depend on itself"), { code: "validation" });
    }
    const row = db.prepare("SELECT id FROM tasks WHERE id = ?").get(dependencyId);
    if (!row) {
      throw Object.assign(new Error(`dependency task not found: ${dependencyId}`), { code: "validation" });
    }
    if (taskId && pathExists(db, dependencyId, taskId)) {
      throw Object.assign(new Error("dependency would create a cycle"), { code: "validation" });
    }
  }
  return ids;
}

function replaceTaskDependencies(db, taskId, dependencyIds) {
  const insert = db.prepare("INSERT INTO task_dependencies (task_id, depends_on_task_id, created_at) VALUES (?, ?, ?)");
  const tx = db.transaction((ids) => {
    db.prepare("DELETE FROM task_dependencies WHERE task_id = ?").run(taskId);
    const now = Date.now();
    for (const dependencyId of ids) insert.run(taskId, dependencyId, now);
  });
  tx(dependencyIds);
}

function rowToRun(row) {
  if (!row) return null;
  const {
    log_id,
    log_model,
    log_effort,
    log_input_tokens,
    log_output_tokens,
    log_cache_read_tokens,
    log_cache_creation_tokens,
    log_cost_usd,
    log_duration_ms,
    log_num_turns,
    log_status,
    ...run
  } = row;
  const hasLog = Boolean(log_id);
  return {
    ...run,
    log: hasLog ? {
      id: log_id,
      model: log_model,
      effort: log_effort,
      input_tokens: log_input_tokens,
      output_tokens: log_output_tokens,
      cache_read_tokens: log_cache_read_tokens,
      cache_creation_tokens: log_cache_creation_tokens,
      cost_usd: log_cost_usd,
      duration_ms: log_duration_ms,
      num_turns: log_num_turns,
      status: log_status,
    } : null,
  };
}

function selectRunsWithLog(db, whereClause, ...params) {
  return db.prepare(`
    SELECT
      r.*,
      l.id AS log_id,
      l.model AS log_model,
      l.effort AS log_effort,
      l.input_tokens AS log_input_tokens,
      l.output_tokens AS log_output_tokens,
      l.cache_read_tokens AS log_cache_read_tokens,
      l.cache_creation_tokens AS log_cache_creation_tokens,
      l.cost_usd AS log_cost_usd,
      l.duration_ms AS log_duration_ms,
      l.num_turns AS log_num_turns,
      l.status AS log_status
    FROM task_runs r
    LEFT JOIN agent_logs l ON l.task_run_id = r.id
    ${whereClause}
    ${RUNS_ORDER_BY}
  `).all(...params).map(rowToRun);
}

export function registerTaskRoutes(app, { db, broker, watcher }) {
  app.get("/api/tasks", (req, res) => {
    const where = [];
    const params = [];
    if (req.query.status) {
      where.push("status = ?");
      params.push(req.query.status);
    }
    if (req.query.agent) {
      where.push("(executor_agent = ? OR reviewer_agent = ?)");
      params.push(req.query.agent, req.query.agent);
    }
    const sql = `SELECT * FROM tasks${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY updated_at DESC`;
    const rows = db.prepare(sql).all(...params);
    const tasks = rows.map(rowToTask).map((t) => enrichTask(db, t));
    res.json({ tasks });
  });

  app.post("/api/tasks", (req, res) => {
    const {
      title,
      instructions = "",
      executor_agent = null,
      reviewer_agent = null,
      tags = [],
      blocked_by_ids = [],
    } = req.body || {};
    if (!title || typeof title !== "string") {
      return res.status(400).json({ error: { code: "validation", message: "title is required" } });
    }
    let dependencyIds = [];
    try {
      dependencyIds = validateDependencyIds(db, null, blocked_by_ids);
    } catch (error) {
      return res.status(400).json({ error: { code: error.code || "validation", message: error.message } });
    }
    const id = newTaskId();
    const now = Date.now();
    db.prepare(`
      INSERT INTO tasks (id, title, instructions, executor_agent, reviewer_agent, tags, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, title, instructions, executor_agent, reviewer_agent, JSON.stringify(tags), now, now);
    replaceTaskDependencies(db, id, dependencyIds);
    const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    const task = enrichTask(db, rowToTask(row));
    broker.broadcast("global", { type: "task_created", id });
    res.status(201).json({ task });
  });

  app.get("/api/tasks/:id", (req, res) => {
    const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id);
    if (!row) return res.status(404).json({ error: { code: "not_found", message: "task not found" } });
    const comments = db
      .prepare("SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at")
      .all(req.params.id);
    const runs = selectRunsWithLog(db, "WHERE r.task_id = ?", req.params.id);
    const task = enrichTask(db, rowToTask(row));
    // §9.3 is_locked: derived from coordinator.active.has(taskId). Null when
    // the watcher isn't wired so the UI can't falsely flag a stuck task.
    task.is_locked = watcher?.isActive ? !!watcher.isActive(req.params.id) : null;
    res.json({ task, comments, runs });
  });

  const PATCHABLE = ["title", "instructions", "executor_agent", "reviewer_agent", "tags"];

  app.patch("/api/tasks/:id", (req, res) => {
    const existing = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: { code: "not_found", message: "task not found" } });

    const fields = [];
    const values = [];

    // Non-status fields
    for (const k of PATCHABLE) {
      if (k in req.body) {
        fields.push(`${k} = ?`);
        values.push(k === "tags" ? JSON.stringify(req.body[k] ?? []) : req.body[k]);
      }
    }

    // Status handling via state machine
    if ("status" in req.body) {
      if (!STATUSES.includes(req.body.status)) {
        return res.status(400).json({ error: { code: "validation", message: "invalid status" } });
      }
      const result = nextStatus(existing.status, { type: "human_move", target: req.body.status });
      if (result.sideEffects.some(se => se.type === "error")) {
        return res.status(400).json({
          error: { code: "invalid_transition", message: result.sideEffects.find(se => se.type === "error").message },
        });
      }
      fields.push("status = ?");
      values.push(result.status);
      for (const se of result.sideEffects) {
        if (se.type === "set_completed_at") { fields.push("completed_at = ?"); values.push(Date.now()); }
        if (se.type === "clear_completed_at") { fields.push("completed_at = ?"); values.push(null); }
      }
    }

    if ("blocked_by_ids" in req.body) {
      try {
        const dependencyIds = validateDependencyIds(db, req.params.id, req.body.blocked_by_ids);
        replaceTaskDependencies(db, req.params.id, dependencyIds);
      } catch (error) {
        return res.status(400).json({ error: { code: error.code || "validation", message: error.message } });
      }
      fields.push("updated_at = ?");
      values.push(Date.now());
    }

    if (fields.length === 0) {
      return res.json({ task: enrichTask(db, rowToTask(existing)) });
    }

    if (!fields.includes("updated_at = ?")) {
      fields.push("updated_at = ?");
      values.push(Date.now());
    }
    values.push(req.params.id);
    db.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`).run(...values);

    const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id);
    broker.broadcast("global", { type: "task_updated", id: req.params.id });
    res.json({ task: enrichTask(db, rowToTask(row)) });
  });

  app.delete("/api/tasks/:id", (req, res) => {
    const r = db.prepare("DELETE FROM tasks WHERE id = ?").run(req.params.id);
    if (r.changes === 0) return res.status(404).json({ error: { code: "not_found", message: "task not found" } });
    broker.broadcast("global", { type: "task_deleted", id: req.params.id });
    res.status(204).end();
  });

  app.post("/api/tasks/:id/comments", (req, res) => {
    const existing = db.prepare("SELECT id FROM tasks WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: { code: "not_found", message: "task not found" } });
    const { body } = req.body || {};
    if (!body || typeof body !== "string") {
      return res.status(400).json({ error: { code: "validation", message: "body is required" } });
    }
    const id = newCommentId();
    const now = Date.now();
    db.prepare(`
      INSERT INTO task_comments (id, task_id, author_type, author_id, body, created_at)
      VALUES (?, ?, 'human', NULL, ?, ?)
    `).run(id, req.params.id, body, now);
    db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(now, req.params.id);
    broker.broadcast("global", { type: "task_updated", id: req.params.id });
    const row = db.prepare("SELECT * FROM task_comments WHERE id = ?").get(id);
    res.status(201).json({ comment: row });
  });

  app.get("/api/tasks/:id/runs", (req, res) => {
    const existing = db.prepare("SELECT id FROM tasks WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: { code: "not_found", message: "task not found" } });
    const runs = selectRunsWithLog(db, "WHERE r.task_id = ?", req.params.id);
    res.json({ runs });
  });

  app.post("/api/tasks/:id/run", async (req, res) => {
    if (!watcher) return res.status(501).json({ error: { code: "not_configured", message: "watcher not wired" } });
    try {
      const result = await watcher.handleRunRequested(req.params.id);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: { code: "invalid_state", message: err.message } });
    }
  });

  app.post("/api/tasks/:id/cancel", (req, res) => {
    if (!watcher) return res.status(501).json({ error: { code: "not_configured", message: "watcher not wired" } });
    const cancelled = watcher.cancel(req.params.id);
    if (!cancelled) return res.status(404).json({ error: { code: "not_running", message: "no active run" } });
    res.status(204).end();
  });
}
