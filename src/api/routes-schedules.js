import { newScheduleId } from "../core/ids.js";
import { cadenceSummary, createTaskFromSchedule, nextFireAt, rowToSchedule, upcomingFireTimes } from "../core/schedules.js";

function validateScheduleInput(body = {}) {
  if (!body.title || typeof body.title !== "string" || !body.title.trim()) {
    throw Object.assign(new Error("title is required"), { status: 400, code: "validation" });
  }
  if ("executor_agent" in body) {
    throw Object.assign(new Error("executor_agent is not supported; use owner_agent"), { status: 400, code: "validation" });
  }
}

function listSummary(db, schedule) {
  const windowStart = Date.now() - 30 * 86_400_000;
  const recent30d = db.prepare(
    "SELECT COUNT(*) AS count FROM schedule_spawns WHERE schedule_id = ? AND fired_at >= ?",
  ).get(schedule.id, windowStart)?.count || 0;
  const recentTasks = db.prepare(`
    SELECT t.id, t.stage, t.title, t.created_at
    FROM schedule_spawns s
    JOIN tasks t ON t.id = s.task_id
    WHERE s.schedule_id = ?
    ORDER BY s.fired_at DESC
    LIMIT 6
  `).all(schedule.id);
  return {
    id: schedule.id,
    title: schedule.title,
    enabled: !!schedule.enabled,
    next_fire_at: schedule.next_fire_at || null,
    last_fired_at: schedule.last_fired_at || null,
    cadence_summary: cadenceSummary(schedule.cadence),
    recent_30d_count: recent30d,
    recent_tasks: recentTasks,
  };
}

function detailPayload(db, schedule) {
  const recentTasks = db.prepare(`
    SELECT
      t.id,
      t.title,
      t.stage,
      t.created_at,
      t.updated_at,
      s.trigger_type,
      s.fired_at
    FROM schedule_spawns s
    JOIN tasks t ON t.id = s.task_id
    WHERE s.schedule_id = ?
    ORDER BY s.fired_at DESC
    LIMIT 12
  `).all(schedule.id);
  return {
    schedule: {
      ...schedule,
      cadence_summary: cadenceSummary(schedule.cadence),
      upcoming_fires: upcomingFireTimes(schedule.cadence, 5, Date.now()),
    },
    recent_tasks: recentTasks,
  };
}

export function registerScheduleRoutes(app, { db, broker, scheduleManager }) {
  app.get("/api/schedules", (_req, res) => {
    const rows = db.prepare("SELECT * FROM schedules ORDER BY updated_at DESC, rowid DESC").all();
    const schedules = rows.map((row) => rowToSchedule(row)).map((schedule) => listSummary(db, schedule));
    res.json({ schedules });
  });

  app.post("/api/schedules", (req, res) => {
    try {
      validateScheduleInput(req.body);
      const now = Date.now();
      const id = newScheduleId();
      const cadence = req.body?.cadence || {};
      const enabled = req.body?.enabled !== false;
      const next_fire_at = enabled ? nextFireAt(cadence, now) : null;
      db.prepare(`
        INSERT INTO schedules (
          id, title, instructions, owner_agent, reviewer_agent,
          tags, cadence_json, enabled, next_fire_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        req.body.title.trim(),
        req.body.instructions || "",
        req.body.owner_agent || null,
        req.body.reviewer_agent || null,
        JSON.stringify(req.body.tags || []),
        JSON.stringify(cadence),
        enabled ? 1 : 0,
        next_fire_at,
        now,
        now,
      );
      scheduleManager?.refresh?.();
      broker?.broadcast?.("global", { type: "schedule_created", id });
      res.status(201).json(detailPayload(db, rowToSchedule(db.prepare("SELECT * FROM schedules WHERE id = ?").get(id))));
    } catch (error) {
      res.status(error.status || 400).json({ error: { code: error.code || "validation", message: error.message } });
    }
  });

  app.get("/api/schedules/:id", (req, res) => {
    const row = db.prepare("SELECT * FROM schedules WHERE id = ?").get(req.params.id);
    if (!row) return res.status(404).json({ error: { code: "not_found", message: "schedule not found" } });
    res.json(detailPayload(db, rowToSchedule(row)));
  });

  app.patch("/api/schedules/:id", (req, res) => {
    const existing = db.prepare("SELECT * FROM schedules WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: { code: "not_found", message: "schedule not found" } });
    const current = rowToSchedule(existing);
    const next = {
      ...current,
      ...req.body,
      title: "title" in (req.body || {}) ? req.body.title : current.title,
      tags: "tags" in (req.body || {}) ? (req.body.tags || []) : current.tags,
      cadence: "cadence" in (req.body || {}) ? req.body.cadence : current.cadence,
    };
    try {
      validateScheduleInput(next);
      const now = Date.now();
      const enabled = next.enabled !== false;
      const nextFire = enabled ? nextFireAt(next.cadence, now) : null;
      db.prepare(`
        UPDATE schedules
        SET title = ?, instructions = ?, owner_agent = ?, reviewer_agent = ?,
            tags = ?, cadence_json = ?, enabled = ?, next_fire_at = ?, updated_at = ?
        WHERE id = ?
      `).run(
        String(next.title).trim(),
        next.instructions || "",
        next.owner_agent || null,
        next.reviewer_agent || null,
        JSON.stringify(next.tags || []),
        JSON.stringify(next.cadence || {}),
        enabled ? 1 : 0,
        nextFire,
        now,
        req.params.id,
      );
      scheduleManager?.refresh?.();
      broker?.broadcast?.("global", { type: "schedule_updated", id: req.params.id });
      res.json(detailPayload(db, rowToSchedule(db.prepare("SELECT * FROM schedules WHERE id = ?").get(req.params.id))));
    } catch (error) {
      res.status(error.status || 400).json({ error: { code: error.code || "validation", message: error.message } });
    }
  });

  app.delete("/api/schedules/:id", (req, res) => {
    const deleted = db.prepare("DELETE FROM schedules WHERE id = ?").run(req.params.id);
    if (!deleted.changes) return res.status(404).json({ error: { code: "not_found", message: "schedule not found" } });
    scheduleManager?.refresh?.();
    broker?.broadcast?.("global", { type: "schedule_deleted", id: req.params.id });
    res.status(204).end();
  });

  app.post("/api/schedules/:id/run", (req, res) => {
    const row = db.prepare("SELECT * FROM schedules WHERE id = ?").get(req.params.id);
    if (!row) return res.status(404).json({ error: { code: "not_found", message: "schedule not found" } });
    const schedule = rowToSchedule(row);
    const task = createTaskFromSchedule({ db, schedule, broker, triggerType: "manual", now: Date.now() });
    broker?.broadcast?.("global", { type: "schedule_triggered", id: req.params.id, taskId: task.id, trigger: "manual" });
    res.status(201).json({ task });
  });
}
