import { newAutomationId } from "../core/ids.js";
import { nextFireAt, normalizeTrigger, parseRunAt, rowToAutomation, triggerSummary, upcomingFireTimes } from "../core/automations.js";
import { legacyRunStatusToProcessStatus } from "../core/state-machine.js";
import { resolveTaskRow } from "../core/task-keys.js";

function validateAutomationInput(body = {}) {
  if (!body.title || typeof body.title !== "string" || !body.title.trim()) {
    throw Object.assign(new Error("title is required"), { status: 400, code: "validation" });
  }
  if ("owner_agent" in body || "reviewer_agent" in body || "executor_agent" in body) {
    throw Object.assign(new Error("automations use agent_name"), { status: 400, code: "validation" });
  }
  if ("cadence" in body || "description" in body || "priority" in body) {
    throw Object.assign(new Error("automations use trigger"), { status: 400, code: "validation" });
  }
  const trigger = body.trigger || {};
  if (trigger.type === "once" && parseRunAt(trigger.run_at) == null) {
    throw Object.assign(new Error("trigger.run_at is required for one-off automations"), { status: 400, code: "validation" });
  }
}

function validateTaskAutomationInput(body = {}) {
  const trigger = body.trigger || {};
  if (trigger.type === "once" && parseRunAt(trigger.run_at) == null) {
    throw Object.assign(new Error("trigger.run_at is required for one-off automations"), { status: 400, code: "validation" });
  }
}

function runRowToPayload(row) {
  if (!row) return null;
  const processStatus = row.status !== "running" && row.process_status === "running"
    ? legacyRunStatusToProcessStatus(row.status)
    : (row.process_status || legacyRunStatusToProcessStatus(row.status));
  return {
    id: row.id,
    automation_id: row.automation_id,
    trigger_type: row.trigger_type,
    fired_at: row.fired_at,
    mode: row.mode,
    agent_name: row.agent_name,
    status: row.status,
    process_status: processStatus,
    started_at: row.started_at,
    ended_at: row.ended_at,
    error_text: row.error_text,
    summary: row.summary,
    details: row.details,
    model: row.model || null,
    duration_ms: row.duration_ms ?? null,
    input_tokens: row.input_tokens ?? null,
    output_tokens: row.output_tokens ?? null,
    cost_usd: row.cost_usd ?? null,
  };
}

function recentRuns(db, automationId, limit = 12) {
  return db.prepare(`
    SELECT
      r.*,
      ar.automation_id,
      ar.trigger_type,
      ar.fired_at,
      l.model,
      l.duration_ms,
      l.input_tokens,
      l.output_tokens,
      l.cost_usd
    FROM automation_runs ar
    JOIN task_runs r ON r.id = ar.run_id
    LEFT JOIN agent_logs l ON l.task_run_id = r.id
    WHERE ar.automation_id = ?
    ORDER BY ar.fired_at DESC
    LIMIT ?
  `).all(automationId, limit).map(runRowToPayload);
}

function recentTriggers(db, automationId, limit = 12) {
  return db.prepare(`
    SELECT id, automation_id, task_id, run_id, trigger_type, outcome, reason, fired_at
    FROM automation_triggers
    WHERE automation_id = ?
    ORDER BY fired_at DESC, rowid DESC
    LIMIT ?
  `).all(automationId, limit);
}

function taskTitle(db, taskId) {
  if (!taskId) return null;
  return db.prepare("SELECT title FROM tasks WHERE id = ?").get(taskId)?.title || null;
}

function taskKey(db, taskId) {
  if (!taskId) return null;
  return db.prepare("SELECT task_key FROM tasks WHERE id = ?").get(taskId)?.task_key || null;
}

function listSummary(db, automation) {
  const windowStart = Date.now() - 30 * 86_400_000;
  const recent30d = db.prepare(
    "SELECT COUNT(*) AS count FROM automation_runs WHERE automation_id = ? AND fired_at >= ?",
  ).get(automation.id, windowStart)?.count || 0;
  return {
    id: automation.id,
    task_id: automation.task_id || null,
    task_key: taskKey(db, automation.task_id),
    task_title: taskTitle(db, automation.task_id),
    title: automation.title,
    agent_name: automation.agent_name || null,
    enabled: !!automation.enabled,
    trigger: automation.trigger,
    trigger_summary: triggerSummary(automation.trigger),
    next_fire_at: automation.next_fire_at || null,
    last_fired_at: automation.last_fired_at || null,
    last_run_id: automation.last_run_id || null,
    last_status: automation.last_status || null,
    last_error: automation.last_error || null,
    recent_30d_count: recent30d,
    recent_runs: recentRuns(db, automation.id, 3),
    recent_triggers: recentTriggers(db, automation.id, 3),
  };
}

function detailPayload(db, automation) {
  return {
    automation: {
      ...automation,
      task_title: taskTitle(db, automation.task_id),
      trigger_summary: triggerSummary(automation.trigger),
      upcoming_fires: upcomingFireTimes(automation.trigger, 5, Date.now()),
    },
    recent_runs: recentRuns(db, automation.id, 20),
    recent_triggers: recentTriggers(db, automation.id, 20),
  };
}

function taskAutomationPayload(db, automation) {
  return {
    ...listSummary(db, automation),
    upcoming_fires: upcomingFireTimes(automation.trigger, 5, Date.now()),
    recent_triggers: recentTriggers(db, automation.id, 8),
  };
}

function getTaskOr404(db, taskId) {
  const task = resolveTaskRow(db, taskId);
  if (!task) throw Object.assign(new Error("task not found"), { status: 404, code: "not_found" });
  return task;
}

function getTaskAutomationOr404(db, taskId, automationId) {
  const row = db.prepare("SELECT * FROM automations WHERE id = ? AND task_id = ?").get(automationId, taskId);
  if (!row) throw Object.assign(new Error("automation not found"), { status: 404, code: "not_found" });
  return rowToAutomation(row);
}

function sendError(res, error, fallbackStatus = 400) {
  return res.status(error.status || fallbackStatus).json({
    error: { code: error.code || "validation", message: error.message },
  });
}

function deleteAutomation(db, automationId) {
  const existing = db.prepare("SELECT id, task_id FROM automations WHERE id = ?").get(automationId);
  if (!existing) return false;
  db.transaction(() => {
    const runs = existing.task_id
      ? []
      : db.prepare("SELECT run_id FROM automation_runs WHERE automation_id = ?").all(automationId);
    db.prepare("DELETE FROM automations WHERE id = ?").run(automationId);
    const deleteRun = db.prepare("DELETE FROM task_runs WHERE id = ?");
    for (const run of runs) deleteRun.run(run.run_id);
  })();
  return existing;
}

export function registerAutomationRoutes(app, { db, broker, automationManager }) {
  app.get("/api/tasks/:taskId/automations", (req, res) => {
    try {
      const task = getTaskOr404(db, req.params.taskId);
      const rows = db.prepare("SELECT * FROM automations WHERE task_id = ? ORDER BY updated_at DESC, rowid DESC").all(task.id);
      const automations = rows.map(rowToAutomation).map((automation) => taskAutomationPayload(db, automation));
      res.json({ automations });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/api/tasks/:taskId/automations", (req, res) => {
    try {
      const task = getTaskOr404(db, req.params.taskId);
      validateTaskAutomationInput(req.body);
      const now = Date.now();
      const id = newAutomationId();
      const trigger = normalizeTrigger(req.body?.trigger || {});
      const enabled = req.body?.enabled !== false;
      const next_fire_at = enabled ? nextFireAt(trigger, now) : null;
      db.prepare(`
        INSERT INTO automations (
          id, task_id, title, instructions, agent_name, tags, trigger_json,
          enabled, next_fire_at, created_at, updated_at
        ) VALUES (?, ?, ?, '', NULL, '[]', ?, ?, ?, ?, ?)
      `).run(
        id,
        task.id,
        task.title,
        JSON.stringify(trigger),
        enabled ? 1 : 0,
        next_fire_at,
        now,
        now,
      );
      automationManager?.refresh?.();
      broker?.broadcast?.("global", { type: "automation_created", id, taskId: task.id });
      broker?.broadcast?.("global", { type: "task_updated", id: task.id });
      res.status(201).json({ automation: taskAutomationPayload(db, rowToAutomation(db.prepare("SELECT * FROM automations WHERE id = ?").get(id))) });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get("/api/tasks/:taskId/automations/:id", (req, res) => {
    try {
      const task = getTaskOr404(db, req.params.taskId);
      res.json({ automation: taskAutomationPayload(db, getTaskAutomationOr404(db, task.id, req.params.id)) });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.patch("/api/tasks/:taskId/automations/:id", (req, res) => {
    try {
      const task = getTaskOr404(db, req.params.taskId);
      const current = getTaskAutomationOr404(db, task.id, req.params.id);
      const nextTrigger = "trigger" in (req.body || {}) ? req.body.trigger : current.trigger;
      validateTaskAutomationInput({ trigger: nextTrigger });
      const now = Date.now();
      const trigger = normalizeTrigger(nextTrigger || {});
      const enabled = "enabled" in (req.body || {}) ? req.body.enabled !== false : current.enabled !== false;
      const nextFire = enabled ? nextFireAt(trigger, now) : null;
      db.prepare(`
        UPDATE automations
        SET title = ?, trigger_json = ?, enabled = ?, next_fire_at = ?, updated_at = ?
        WHERE id = ? AND task_id = ?
      `).run(task.title, JSON.stringify(trigger), enabled ? 1 : 0, nextFire, now, req.params.id, task.id);
      automationManager?.refresh?.();
      broker?.broadcast?.("global", { type: "automation_updated", id: req.params.id, taskId: task.id });
      broker?.broadcast?.("global", { type: "task_updated", id: task.id });
      res.json({ automation: taskAutomationPayload(db, rowToAutomation(db.prepare("SELECT * FROM automations WHERE id = ?").get(req.params.id))) });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.delete("/api/tasks/:taskId/automations/:id", (req, res) => {
    try {
      const task = getTaskOr404(db, req.params.taskId);
      getTaskAutomationOr404(db, task.id, req.params.id);
      if (automationManager?.isActive?.(req.params.id)) {
        return res.status(409).json({ error: { code: "automation_running", message: "automation is running" } });
      }
      deleteAutomation(db, req.params.id);
      automationManager?.refresh?.();
      broker?.broadcast?.("global", { type: "automation_deleted", id: req.params.id, taskId: task.id });
      broker?.broadcast?.("global", { type: "task_updated", id: task.id });
      res.status(204).end();
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/api/tasks/:taskId/automations/:id/run", async (req, res) => {
    if (!automationManager?.runNow) {
      return res.status(501).json({ error: { code: "not_configured", message: "automation manager not wired" } });
    }
    try {
      const task = getTaskOr404(db, req.params.taskId);
      getTaskAutomationOr404(db, task.id, req.params.id);
      const result = await automationManager.runNow(req.params.id, { triggerType: "manual" });
      res.status(result?.skipped ? 202 : 201).json(result);
    } catch (error) {
      const notFound = /not found/.test(error.message || "") || error.code === "not_found";
      res.status(notFound ? 404 : 400).json({ error: { code: notFound ? "not_found" : "invalid_state", message: error.message } });
    }
  });

  app.get("/api/automations", (_req, res) => {
    const rows = db.prepare("SELECT * FROM automations ORDER BY updated_at DESC, rowid DESC").all();
    const automations = rows.map((row) => rowToAutomation(row)).map((automation) => listSummary(db, automation));
    res.json({ automations });
  });

  app.post("/api/automations", (req, res) => {
    try {
      validateAutomationInput(req.body);
      const now = Date.now();
      const id = newAutomationId();
      const trigger = normalizeTrigger(req.body?.trigger || {});
      const enabled = req.body?.enabled !== false;
      const next_fire_at = enabled ? nextFireAt(trigger, now) : null;
      db.prepare(`
        INSERT INTO automations (
          id, title, instructions, agent_name, tags, trigger_json,
          enabled, next_fire_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        req.body.title.trim(),
        req.body.instructions || "",
        req.body.agent_name || null,
        JSON.stringify(req.body.tags || []),
        JSON.stringify(trigger),
        enabled ? 1 : 0,
        next_fire_at,
        now,
        now,
      );
      automationManager?.refresh?.();
      broker?.broadcast?.("global", { type: "automation_created", id });
      res.status(201).json(detailPayload(db, rowToAutomation(db.prepare("SELECT * FROM automations WHERE id = ?").get(id))));
    } catch (error) {
      res.status(error.status || 400).json({ error: { code: error.code || "validation", message: error.message } });
    }
  });

  app.get("/api/automations/:id", (req, res) => {
    const row = db.prepare("SELECT * FROM automations WHERE id = ?").get(req.params.id);
    if (!row) return res.status(404).json({ error: { code: "not_found", message: "automation not found" } });
    res.json(detailPayload(db, rowToAutomation(row)));
  });

  app.patch("/api/automations/:id", (req, res) => {
    const existing = db.prepare("SELECT * FROM automations WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: { code: "not_found", message: "automation not found" } });
    const current = rowToAutomation(existing);
    const next = {
      ...current,
      ...req.body,
      title: "title" in (req.body || {}) ? req.body.title : current.title,
      tags: "tags" in (req.body || {}) ? (req.body.tags || []) : current.tags,
      trigger: "trigger" in (req.body || {}) ? req.body.trigger : current.trigger,
    };
    try {
      validateAutomationInput(next);
      const now = Date.now();
      const trigger = normalizeTrigger(next.trigger || {});
      const enabled = next.enabled !== false;
      const nextFire = enabled ? nextFireAt(trigger, now) : null;
      db.prepare(`
        UPDATE automations
        SET title = ?, instructions = ?, agent_name = ?, tags = ?,
            trigger_json = ?, enabled = ?, next_fire_at = ?, updated_at = ?
        WHERE id = ?
      `).run(
        String(next.title).trim(),
        next.instructions || "",
        next.agent_name || null,
        JSON.stringify(next.tags || []),
        JSON.stringify(trigger),
        enabled ? 1 : 0,
        nextFire,
        now,
        req.params.id,
      );
      automationManager?.refresh?.();
      broker?.broadcast?.("global", { type: "automation_updated", id: req.params.id });
      res.json(detailPayload(db, rowToAutomation(db.prepare("SELECT * FROM automations WHERE id = ?").get(req.params.id))));
    } catch (error) {
      res.status(error.status || 400).json({ error: { code: error.code || "validation", message: error.message } });
    }
  });

  app.delete("/api/automations/:id", (req, res) => {
    const existing = db.prepare("SELECT id, task_id FROM automations WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: { code: "not_found", message: "automation not found" } });
    if (automationManager?.isActive?.(req.params.id)) {
      return res.status(409).json({ error: { code: "automation_running", message: "automation is running" } });
    }
    deleteAutomation(db, req.params.id);
    automationManager?.refresh?.();
    broker?.broadcast?.("global", { type: "automation_deleted", id: req.params.id, taskId: existing.task_id || null });
    if (existing.task_id) broker?.broadcast?.("global", { type: "task_updated", id: existing.task_id });
    res.status(204).end();
  });

  app.post("/api/automations/:id/run", async (req, res) => {
    if (!automationManager?.runNow) {
      return res.status(501).json({ error: { code: "not_configured", message: "automation manager not wired" } });
    }
    try {
      const result = await automationManager.runNow(req.params.id, { triggerType: "manual" });
      res.status(result?.skipped ? 202 : 201).json(result);
    } catch (error) {
      const notFound = /not found/.test(error.message || "");
      res.status(notFound ? 404 : 400).json({ error: { code: notFound ? "not_found" : "invalid_state", message: error.message } });
    }
  });
}
