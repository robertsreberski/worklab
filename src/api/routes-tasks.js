import { newTaskId, newCommentId } from "../core/ids.js";
import { enrichCommentRows } from "../core/comments.js";
import { nextStage, STAGES, legacyRunStatusToProcessStatus } from "../core/state-machine.js";
import { applyTaskSideEffects, taskStage } from "../core/task-side-effects.js";
import { resumeWaitingParents } from "../core/task-joins.js";
import { nextTaskKey, resolveTaskId, resolveTaskRow } from "../core/task-keys.js";
import { supportsLiveInputProvider } from "../core/live-input.js";
import { buildNextTaskRunPreview } from "../core/run-input.js";
import { buildRunLifecycleEvent } from "../core/run-events.js";

const RUNS_ORDER_BY = "ORDER BY r.started_at DESC, r.rowid DESC";
const RUN_POLICIES = ["manual", "auto_plan_execute"];
const DEFAULT_RUN_POLICY = "auto_plan_execute";
const PATCHABLE = ["title", "instructions", "reviewer_agent", "owner_agent", "planner_agent", "tags", "run_policy"];
const BULK_PATCHABLE = ["stage", "owner_agent", "planner_agent", "reviewer_agent", "run_policy"];

function rowToTask(row) {
  if (!row) return null;
  const stage = row.stage || "plan";
  return {
    ...row,
    stage,
    tags: JSON.parse(row.tags || "[]"),
    retry_count: row.retry_count ?? 0,
    run_policy: row.run_policy || DEFAULT_RUN_POLICY,
    root_task_id: row.root_task_id || row.id,
    parent_task_id: row.parent_task_id || null,
    owner_agent: row.owner_agent || null,
    planner_agent: row.planner_agent || null,
    delegated_to_agent: row.delegated_to_agent || null,
    delegated_by_run_id: row.delegated_by_run_id || null,
    plan_body: row.plan_body || "",
    plan_updated_at: row.plan_updated_at || null,
    plan_updated_by: row.plan_updated_by || null,
    plan_source_run_id: row.plan_source_run_id || null,
    required: row.required !== 0,
    pending_actions: JSON.parse(row.pending_actions_json || "[]"),
    blocking_issues: JSON.parse(row.blocking_issues_json || "[]"),
  };
}

function compactTaskSummary(row) {
  const task = rowToTask(row);
  if (!task) return null;
  return {
    id: task.id,
    task_key: task.task_key || null,
    title: task.title,
    stage: task.stage,
    updated_at: task.updated_at,
    owner_agent: task.owner_agent,
    planner_agent: task.planner_agent,
    reviewer_agent: task.reviewer_agent,
    run_policy: task.run_policy,
  };
}

function parseEvents(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// §9.3 derived fields.
// `running_run_id` — latest task_runs row where status='running', or null.
// `last_run` — latest completed run summary (id, status, ended_at) for §5.3
//              error-chip policy.
function attachDerivedRunFields(db, task) {
  if (!task) return task;
  const runningRow = db.prepare(
    `SELECT id, status, process_status, started_at FROM task_runs
     WHERE task_id = ? AND status = 'running'
     ORDER BY started_at DESC LIMIT 1`
  ).get(task.id);
  const runningLog = runningRow
    ? db.prepare("SELECT events FROM agent_logs WHERE task_run_id = ?").get(runningRow.id)
    : null;
  const runningEvents = runningLog ? parseEvents(runningLog.events) : [];
  const lastRow = db.prepare(
    `SELECT id, status, process_status, failure_kind, ended_at, stage, mode, decision, summary
     FROM task_runs
     WHERE task_id = ? AND status <> 'running'
     ORDER BY started_at DESC LIMIT 1`
  ).get(task.id);
  return {
    ...task,
    running_run_id: runningRow?.id || null,
    running_run: runningRow ? {
      id: runningRow.id,
      status: runningRow.status,
      process_status: runningRow.process_status || legacyRunStatusToProcessStatus(runningRow.status),
      started_at: runningRow.started_at,
      event_count: runningEvents.length,
      last_event: runningEvents[runningEvents.length - 1] || null,
    } : null,
    last_run: lastRow ? {
      id: lastRow.id,
      status: lastRow.status,
      process_status: lastRow.status !== "running" && lastRow.process_status === "running"
        ? legacyRunStatusToProcessStatus(lastRow.status)
        : (lastRow.process_status || legacyRunStatusToProcessStatus(lastRow.status)),
      failure_kind: lastRow.failure_kind || null,
      ended_at: lastRow.ended_at,
      stage: lastRow.stage || (lastRow.mode === "review" ? "review" : "execute"),
      decision: lastRow.decision || null,
      summary: lastRow.summary || null,
    } : null,
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
  const childRows = db.prepare(`
    SELECT t.*, e.required AS edge_required, e.edge_type
    FROM task_edges e
    JOIN tasks t ON t.id = e.child_task_id
    WHERE e.parent_task_id = ? AND e.edge_type = 'subtask'
    ORDER BY t.subtask_order ASC, t.created_at ASC
  `).all(task.id);
  const parentRow = task.parent_task_id
    ? db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.parent_task_id)
    : null;
  return {
    ...task,
    dependency_ids: dependencyRows.map((row) => row.id),
    blocked_by: dependencyRows.map(compactTaskSummary),
    blocks: dependentRows.map(compactTaskSummary),
    parent: compactTaskSummary(parentRow),
    children: childRows.map((row) => ({
      ...compactTaskSummary(row),
      edge_type: row.edge_type,
      required: row.edge_required !== 0,
    })),
  };
}

function attachAutomationSummary(db, task) {
  if (!task) return task;
  const rows = db.prepare(`
    SELECT id, enabled, next_fire_at, last_status, last_error
    FROM automations
    WHERE task_id = ?
  `).all(task.id);
  const enabled = rows.filter((row) => row.enabled !== 0);
  const nextFireAt = enabled
    .map((row) => row.next_fire_at)
    .filter((value) => value != null)
    .sort((a, b) => a - b)[0] || null;
  const latestTrigger = db.prepare(`
    SELECT id, automation_id, task_id, run_id, trigger_type, outcome, reason, fired_at
    FROM automation_triggers
    WHERE task_id = ?
    ORDER BY fired_at DESC, rowid DESC
    LIMIT 1
  `).get(task.id) || null;
  return {
    ...task,
    automation_summary: {
      count: rows.length,
      enabled_count: enabled.length,
      paused_count: rows.length - enabled.length,
      next_fire_at: nextFireAt,
      last_trigger: latestTrigger,
    },
  };
}

function enrichTask(db, task) {
  return attachAutomationSummary(db, attachTaskGraph(db, attachDerivedRunFields(db, task)));
}

function normaliseDependencyIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry) => typeof entry === "string" && entry.trim().length > 0))];
}

function normaliseClientRequestId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 160);
}

function normalizeRunPolicy(value, fallback = DEFAULT_RUN_POLICY) {
  if (value === undefined) return fallback;
  if (RUN_POLICIES.includes(value)) return value;
  throw Object.assign(new Error(`invalid run_policy: ${value}`), { code: "validation" });
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
  const resolvedIds = [];
  for (const inputId of ids) {
    const dependencyId = resolveTaskId(db, inputId);
    if (!dependencyId) {
      throw Object.assign(new Error(`dependency task not found: ${inputId}`), { code: "validation" });
    }
    if (taskId && dependencyId === taskId) {
      throw Object.assign(new Error("a task cannot depend on itself"), { code: "validation" });
    }
    if (taskId && pathExists(db, dependencyId, taskId)) {
      throw Object.assign(new Error("dependency would create a cycle"), { code: "validation" });
    }
    resolvedIds.push(dependencyId);
  }
  return [...new Set(resolvedIds)];
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

function applyRouteSideEffects(db, broker, logger, taskId, sideEffects, currentStage, newStage) {
  const tx = db.transaction(() => {
    applyTaskSideEffects(db, taskId, sideEffects, currentStage, newStage, { logger });
  });
  tx();
  const taskKey = db.prepare("SELECT task_key FROM tasks WHERE id = ?").get(taskId)?.task_key || null;
  broker.broadcast("global", { type: "task_updated", id: taskId, taskKey });
}

function nullableAgentName(value, fallback = null) {
  if (value === undefined) return fallback;
  if (value === null) return null;
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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
    process_status: run.status !== "running" && run.process_status === "running"
      ? legacyRunStatusToProcessStatus(run.status)
      : (run.process_status || legacyRunStatusToProcessStatus(run.status)),
    stage: run.stage || (run.mode === "review" ? "review" : "execute"),
    artifact_paths: JSON.parse(run.artifact_paths_json || "[]"),
    result: run.result_json ? JSON.parse(run.result_json) : null,
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

function liveInputForRun(run, watcher) {
  const supported = supportsLiveInputProvider(run?.provider_kind);
  const state = watcher?.getRunLiveInputState?.(run.id) || null;
  return {
    supported,
    active: !!(supported && state?.active),
    reason: supported ? (state?.reason || null) : "unsupported_provider",
  };
}

function attachLiveInputState(runs, watcher) {
  return (runs || []).map((run) => ({
    ...run,
    live_input: liveInputForRun(run, watcher),
  }));
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
	      l.status AS log_status,
	      ar.automation_id,
	      ar.trigger_type AS automation_trigger_type,
	      ar.fired_at AS automation_fired_at,
	      a.title AS automation_title,
	      a.task_id AS automation_task_id
	    FROM task_runs r
	    LEFT JOIN agent_logs l ON l.task_run_id = r.id
	    LEFT JOIN automation_runs ar ON ar.run_id = r.id
	    LEFT JOIN automations a ON a.id = ar.automation_id
	    ${whereClause}
	    ${RUNS_ORDER_BY}
  `).all(...params).map(rowToRun);
}

function routeError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function sendRouteError(res, error) {
  if (!error?.status) throw error;
  return res.status(error.status).json({
    error: { code: error.code || "error", message: error.message },
  });
}

function rerunResponseError(error, fallbackCode = "invalid_state") {
  return {
    requested: true,
    started: false,
    error: {
      code: error?.code || fallbackCode,
      message: error?.message || "rerun failed",
    },
  };
}

async function requestCommentRerun({ db, broker, watcher, logger, taskId }) {
  if (!watcher?.handleRunRequested) {
    return rerunResponseError({ code: "not_configured", message: "watcher not wired" });
  }

  const runningRow = db.prepare(`
    SELECT id
    FROM task_runs
    WHERE task_id = ? AND status = 'running'
    ORDER BY started_at DESC
    LIMIT 1
  `).get(taskId);
  if (watcher.isActive?.(taskId) || runningRow) {
    return rerunResponseError({ code: "already_running", message: "task already running" });
  }

  try {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    if (!task) return rerunResponseError({ code: "not_found", message: "task not found" }, "not_found");

    const currentStage = taskStage(task);
    if (!["plan", "execute", "review"].includes(currentStage)) {
      const result = nextStage(currentStage, { type: "human_move", target: "execute" });
      const errorSideEffect = result.sideEffects.find((se) => se.type === "error");
      if (errorSideEffect) {
        return rerunResponseError({ code: "invalid_transition", message: errorSideEffect.message });
      }
      applyRouteSideEffects(db, broker, logger, taskId, result.sideEffects, currentStage, result.stage);
    }

    const result = await watcher.handleRunRequested(taskId);
    return { requested: true, started: true, runId: result?.runId || null };
  } catch (error) {
    return rerunResponseError(error);
  }
}

function applyTaskPatchById({ db, broker, watcher, logger, taskId, patch = {} }) {
  const existing = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
  if (!existing) throw routeError(404, "not_found", "task not found");
  if ("executor_agent" in (patch || {})) {
    throw routeError(400, "validation", "executor_agent is not supported; use owner_agent");
  }
  if ("status" in (patch || {})) {
    throw routeError(400, "validation", "status is not supported; use stage");
  }

  const fields = [];
  const values = [];
  let stageTransition = null;

  // Non-status fields
  for (const k of PATCHABLE) {
    if (k in patch) {
      fields.push(`${k} = ?`);
      if (k === "tags") values.push(JSON.stringify(patch[k] ?? []));
      else if (k === "run_policy") {
        try {
          values.push(normalizeRunPolicy(patch[k], existing.run_policy || DEFAULT_RUN_POLICY));
        } catch (error) {
          throw routeError(400, error.code || "validation", error.message);
        }
      } else values.push(patch[k]);
    }
  }

  if ("plan_body" in patch) {
    if (patch.plan_body != null && typeof patch.plan_body !== "string") {
      throw routeError(400, "validation", "plan_body must be a string");
    }
    const now = Date.now();
    fields.push("plan_body = ?");
    values.push(patch.plan_body || "");
    fields.push("plan_updated_at = ?");
    values.push(now);
    fields.push("plan_updated_by = ?");
    values.push("human");
    fields.push("plan_source_run_id = ?");
    values.push(null);
  }

  if ("stage" in patch) {
    const requested = patch.stage;
    if (!STAGES.includes(requested)) {
      throw routeError(400, "validation", "invalid stage");
    }
    const currentStage = taskStage(existing);
    const result = nextStage(currentStage, { type: "human_move", target: requested });
    const errorSideEffect = result.sideEffects.find((se) => se.type === "error");
    if (errorSideEffect) {
      throw routeError(400, "invalid_transition", errorSideEffect.message);
    }
    stageTransition = { currentStage, result };
  }

  if ("blocked_by_ids" in patch) {
    try {
      const dependencyIds = validateDependencyIds(db, taskId, patch.blocked_by_ids);
      replaceTaskDependencies(db, taskId, dependencyIds);
    } catch (error) {
      throw routeError(400, error.code || "validation", error.message);
    }
    fields.push("updated_at = ?");
    values.push(Date.now());
  }

  if (fields.length === 0 && !stageTransition) {
    return enrichTask(db, rowToTask(existing));
  }

  if (fields.length > 0) {
    if (!fields.includes("updated_at = ?")) {
      fields.push("updated_at = ?");
      values.push(Date.now());
    }
    values.push(taskId);
    db.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    broker?.broadcast?.("global", { type: "task_updated", id: taskId, taskKey: existing.task_key || null });
  }

  if (stageTransition) {
    applyRouteSideEffects(
      db,
      broker,
      logger,
      taskId,
      stageTransition.result.sideEffects,
      stageTransition.currentStage,
      stageTransition.result.stage,
    );
    if (stageTransition.result.stage === "done" || stageTransition.result.stage === "blocked") {
      resumeWaitingParents({
        db,
        childTaskId: taskId,
        applySideEffects: (parentTaskId, sideEffects, currentStage, newStage) => {
          applyRouteSideEffects(db, broker, logger, parentTaskId, sideEffects, currentStage, newStage);
        },
      });
    }
    if (stageTransition.result.stage === "done") {
      watcher?.maybeAutoStartDependents?.(taskId);
    }
  }
  watcher?.maybeAutoStart?.(taskId);

  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
  return enrichTask(db, rowToTask(row));
}

function deleteTaskById({ db, broker, watcher, taskId }) {
  const existing = db.prepare("SELECT task_key FROM tasks WHERE id = ?").get(taskId);
  const running = db.prepare(
    `SELECT id FROM task_runs
     WHERE task_id = ? AND status = 'running'
     LIMIT 1`,
  ).get(taskId);
  if (running || watcher?.isActive?.(taskId)) {
    throw routeError(409, "task_running", "cancel the active run before deleting this task");
  }
  const r = db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
  if (r.changes === 0) throw routeError(404, "not_found", "task not found");
  broker?.broadcast?.("global", { type: "task_deleted", id: taskId, taskKey: existing?.task_key || null });
}

function normalizeBulkIds(value) {
  if (!Array.isArray(value)) {
    throw routeError(400, "validation", "ids must be an array");
  }
  const ids = [...new Set(value.filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim()))];
  if (ids.length === 0) {
    throw routeError(400, "validation", "ids are required");
  }
  return ids;
}

function validateBulkPatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw routeError(400, "validation", "patch is required");
  }
  const keys = Object.keys(patch);
  if (keys.length === 0) {
    throw routeError(400, "validation", "patch is required");
  }
  for (const key of keys) {
    if (!BULK_PATCHABLE.includes(key)) {
      throw routeError(400, "validation", `unsupported bulk patch field: ${key}`);
    }
  }
  if ("stage" in patch && !STAGES.includes(patch.stage)) {
    throw routeError(400, "validation", "invalid stage");
  }
  if ("run_policy" in patch) {
    try {
      normalizeRunPolicy(patch.run_policy);
    } catch (error) {
      throw routeError(400, error.code || "validation", error.message);
    }
  }
}

function bulkSummary(results) {
  const succeeded = results.filter((result) => result.ok).length;
  return {
    requested: results.length,
    succeeded,
    failed: results.length - succeeded,
  };
}

function resultError(error) {
  return {
    code: error.code || "error",
    message: error.message || "failed",
    status: error.status || 500,
  };
}

function taskOr404(db, value) {
  const task = resolveTaskRow(db, value);
  if (!task) throw routeError(404, "not_found", "task not found");
  return task;
}

export function registerTaskRoutes(app, { db, broker, watcher, logger, dataDir, repoRoot, config }) {
  app.get("/api/tasks", (req, res) => {
    const where = [];
    const params = [];
    if (req.query.status) {
      return res.status(400).json({
        error: { code: "validation", message: "status is not supported; use stage" },
      });
    }
    if (req.query.stage) {
      if (!STAGES.includes(req.query.stage)) {
        return res.status(400).json({ error: { code: "validation", message: `invalid stage: ${req.query.stage}` } });
      }
      where.push("stage = ?");
      params.push(req.query.stage);
    }
    if (req.query.agent) {
      where.push("(owner_agent = ? OR planner_agent = ? OR reviewer_agent = ?)");
      params.push(req.query.agent, req.query.agent, req.query.agent);
    }
    const sql = `SELECT * FROM tasks${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY updated_at DESC`;
    const rows = db.prepare(sql).all(...params);
    const tasks = rows.map(rowToTask).map((t) => enrichTask(db, t));
    res.json({ tasks });
  });

  app.post("/api/tasks", (req, res) => {
    if ("executor_agent" in (req.body || {})) {
      return res.status(400).json({
        error: { code: "validation", message: "executor_agent is not supported; use owner_agent" },
      });
    }
    if ("status" in (req.body || {})) {
      return res.status(400).json({
        error: { code: "validation", message: "status is not supported; use stage" },
      });
    }
    const {
      title,
      instructions = "",
      reviewer_agent = null,
      owner_agent = null,
      planner_agent = null,
      stage = "plan",
      run_policy = DEFAULT_RUN_POLICY,
      tags = [],
      blocked_by_ids = [],
      client_request_id = null,
    } = req.body || {};
    const requestId = normaliseClientRequestId(client_request_id);
    if (requestId) {
      const existing = db.prepare("SELECT * FROM tasks WHERE client_request_id = ?").get(requestId);
      if (existing) return res.status(200).json({ task: enrichTask(db, rowToTask(existing)) });
    }
    if (!title || typeof title !== "string") {
      return res.status(400).json({ error: { code: "validation", message: "title is required" } });
    }
    if (!STAGES.includes(stage)) {
      return res.status(400).json({ error: { code: "validation", message: `invalid stage: ${stage}` } });
    }
    let normalizedRunPolicy = DEFAULT_RUN_POLICY;
    try {
      normalizedRunPolicy = normalizeRunPolicy(run_policy);
    } catch (error) {
      return res.status(400).json({ error: { code: error.code || "validation", message: error.message } });
    }
    let dependencyIds = [];
    try {
      dependencyIds = validateDependencyIds(db, null, blocked_by_ids);
    } catch (error) {
      return res.status(400).json({ error: { code: error.code || "validation", message: error.message } });
    }
    const now = Date.now();
    const insertTask = db.prepare(`
      INSERT INTO tasks
        (id, task_key, root_task_id, client_request_id, title, instructions, stage, owner_agent,
         planner_agent, reviewer_agent, run_policy, tags, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let id;
    try {
      db.transaction(() => {
        id = newTaskId();
        insertTask.run(
          id,
          nextTaskKey(db),
          id,
          requestId,
          title,
          instructions,
          stage,
          owner_agent,
          planner_agent,
          reviewer_agent,
          normalizedRunPolicy,
          JSON.stringify(tags),
          now,
          now,
        );
        replaceTaskDependencies(db, id, dependencyIds);
      })();
    } catch (error) {
      if (requestId && String(error?.code || "").includes("SQLITE_CONSTRAINT")) {
        const existing = db.prepare("SELECT * FROM tasks WHERE client_request_id = ?").get(requestId);
        if (existing) return res.status(200).json({ task: enrichTask(db, rowToTask(existing)) });
      }
      throw error;
    }
    const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    const task = enrichTask(db, rowToTask(row));
    broker.broadcast("global", { type: "task_created", id, taskKey: task.task_key || null });
    watcher?.maybeAutoStart?.(id);
    res.status(201).json({ task });
  });

  app.post("/api/tasks/bulk", (req, res) => {
    let ids;
    try {
      ids = normalizeBulkIds(req.body?.ids);
      const operation = req.body?.operation;
      if (!["patch", "delete"].includes(operation)) {
        throw routeError(400, "validation", "operation must be patch or delete");
      }
      if (operation === "patch") validateBulkPatch(req.body?.patch);

      const results = ids.map((inputId) => {
        try {
          const taskRow = taskOr404(db, inputId);
          if (operation === "delete") {
            deleteTaskById({ db, broker, watcher, taskId: taskRow.id });
            return { id: inputId, task_id: taskRow.id, ok: true };
          }
          const task = applyTaskPatchById({
            db,
            broker,
            watcher,
            logger,
            taskId: taskRow.id,
            patch: req.body.patch,
          });
          return { id: inputId, task_id: taskRow.id, ok: true, task };
        } catch (error) {
          return { id: inputId, ok: false, error: resultError(error) };
        }
      });

      res.json({ summary: bulkSummary(results), results });
    } catch (error) {
      return sendRouteError(res, error);
    }
  });

  app.get("/api/tasks/:id", (req, res) => {
    const row = resolveTaskRow(db, req.params.id);
    if (!row) return res.status(404).json({ error: { code: "not_found", message: "task not found" } });
    const comments = enrichCommentRows(db, db
      .prepare("SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at")
      .all(row.id));
    const runs = attachLiveInputState(selectRunsWithLog(db, "WHERE r.task_id = ?", row.id), watcher);
    const task = enrichTask(db, rowToTask(row));
    // §9.3 is_locked: derived from coordinator.active.has(taskId). Null when
    // the watcher isn't wired so the UI can't falsely flag a stuck task.
    task.is_locked = watcher?.isActive ? !!watcher.isActive(row.id) : null;
    res.json({ task, comments, runs });
  });

  app.patch("/api/tasks/:id", (req, res) => {
    try {
      const taskRow = taskOr404(db, req.params.id);
      const task = applyTaskPatchById({
        db,
        broker,
        watcher,
        logger,
        taskId: taskRow.id,
        patch: req.body || {},
      });
      res.json({ task });
    } catch (error) {
      return sendRouteError(res, error);
    }
  });

  app.post("/api/tasks/:id/subtasks", (req, res) => {
    const parent = resolveTaskRow(db, req.params.id);
    if (!parent) return res.status(404).json({ error: { code: "not_found", message: "task not found" } });

    const body = req.body || {};
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) {
      return res.status(400).json({ error: { code: "validation", message: "title is required" } });
    }
    const instructions = typeof body.instructions === "string" ? body.instructions : "";
    const ownerAgent = nullableAgentName(body.owner_agent, parent.owner_agent || null);
    const plannerAgent = nullableAgentName(body.planner_agent, parent.planner_agent || null);
    const reviewerAgent = nullableAgentName(body.reviewer_agent, parent.reviewer_agent || null);
    const required = body.required === false ? 0 : 1;
    const now = Date.now();
    const childId = newTaskId();
    const rootTaskId = parent.root_task_id || parent.id;
    const orderRow = db.prepare("SELECT COALESCE(MAX(subtask_order), -1) AS max_order FROM tasks WHERE parent_task_id = ?").get(parent.id);
    const subtaskOrder = Number(orderRow?.max_order ?? -1) + 1;
    const shouldWait = required === 1 && !["done", "blocked"].includes(taskStage(parent));

    try {
      db.transaction(() => {
        db.prepare(`
          INSERT INTO tasks
            (id, task_key, root_task_id, parent_task_id, owner_agent, planner_agent, reviewer_agent,
             title, instructions, stage, run_policy, join_policy, subtask_order, required,
             tags, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'plan', ?, 'all_required', ?, ?, ?, ?, ?)
        `).run(
          childId,
          nextTaskKey(db),
          rootTaskId,
          parent.id,
          ownerAgent,
          plannerAgent,
          reviewerAgent,
          title,
          instructions,
          parent.run_policy || DEFAULT_RUN_POLICY,
          subtaskOrder,
          required,
          JSON.stringify([]),
          now,
          now,
        );
        db.prepare(`
          INSERT INTO task_edges
            (parent_task_id, child_task_id, edge_type, required, created_by_run_id, created_at)
          VALUES (?, ?, 'subtask', ?, NULL, ?)
        `).run(parent.id, childId, required, now);
        if (shouldWait) {
          db.prepare(`
            UPDATE tasks
            SET stage = 'awaiting_children',
                stage_reason = 'waiting for manual subtasks',
                error_text = NULL,
                completed_at = NULL,
                pending_actions_json = '[]',
                blocking_issues_json = '[]',
                updated_at = ?
            WHERE id = ?
          `).run(now, parent.id);
        } else {
          db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(now, parent.id);
        }
      })();
    } catch (error) {
      if (String(error?.code || "").includes("SQLITE_CONSTRAINT")) {
        return res.status(400).json({ error: { code: "validation", message: error.message } });
      }
      throw error;
    }

    const child = enrichTask(db, rowToTask(db.prepare("SELECT * FROM tasks WHERE id = ?").get(childId)));
    const updatedParent = enrichTask(db, rowToTask(db.prepare("SELECT * FROM tasks WHERE id = ?").get(parent.id)));
    broker.broadcast("global", { type: "task_created", id: childId, taskKey: child.task_key || null });
    broker.broadcast("global", { type: "task_updated", id: parent.id, taskKey: updatedParent.task_key || null });
    watcher?.maybeAutoStart?.(childId);
    res.status(201).json({ task: child, parent: updatedParent });
  });

  app.delete("/api/tasks/:id", (req, res) => {
    try {
      const taskRow = taskOr404(db, req.params.id);
      deleteTaskById({ db, broker, watcher, taskId: taskRow.id });
      res.status(204).end();
    } catch (error) {
      return sendRouteError(res, error);
    }
  });

  app.post("/api/tasks/:id/comments", async (req, res) => {
    const existing = resolveTaskRow(db, req.params.id);
    if (!existing) return res.status(404).json({ error: { code: "not_found", message: "task not found" } });
    const { body, rerun } = req.body || {};
    if (!body || typeof body !== "string") {
      return res.status(400).json({ error: { code: "validation", message: "body is required" } });
    }
    const id = newCommentId();
    const now = Date.now();
    db.prepare(`
      INSERT INTO task_comments (id, task_id, author_type, author_id, body, created_at)
      VALUES (?, ?, 'human', NULL, ?, ?)
    `).run(id, existing.id, body, now);
    db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(now, existing.id);
    broker.broadcast("global", { type: "task_updated", id: existing.id, taskKey: existing.task_key || null });
    const row = enrichCommentRows(db, db.prepare("SELECT * FROM task_comments WHERE id = ?").all(id))[0];
    const payload = { comment: row };
    if (rerun === true) {
      payload.rerun = await requestCommentRerun({ db, broker, watcher, logger, taskId: existing.id });
    }
    res.status(201).json(payload);
  });

  app.delete("/api/tasks/:id/comments/:commentId", (req, res) => {
    try {
      const existing = taskOr404(db, req.params.id);
      const requestedCommentId = String(req.params.commentId || "");
      let comment = db.prepare("SELECT * FROM task_comments WHERE id = ? AND task_id = ?")
        .get(requestedCommentId, existing.id);
      if (!comment && requestedCommentId.startsWith("c-")) {
        comment = db.prepare("SELECT * FROM task_comments WHERE id = ? AND task_id = ?")
          .get(requestedCommentId.slice(2), existing.id);
      }
      if (!comment) throw routeError(404, "not_found", "comment not found");
      if (comment.author_type !== "human") {
        throw routeError(403, "forbidden", "only human comments can be deleted");
      }
      const now = Date.now();
      db.transaction(() => {
        db.prepare("DELETE FROM task_comments WHERE id = ? AND task_id = ?").run(comment.id, existing.id);
        db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(now, existing.id);
      })();
      broker.broadcast("global", { type: "task_updated", id: existing.id, taskKey: existing.task_key || null });
      res.status(204).end();
    } catch (error) {
      return sendRouteError(res, error);
    }
  });

  app.get("/api/tasks/:id/runs", (req, res) => {
    const existing = resolveTaskRow(db, req.params.id);
    if (!existing) return res.status(404).json({ error: { code: "not_found", message: "task not found" } });
    const runs = attachLiveInputState(selectRunsWithLog(db, "WHERE r.task_id = ?", existing.id), watcher);
    res.json({ runs });
  });

  app.get("/api/tasks/:id/run-preview", (req, res) => {
    try {
      const taskRow = taskOr404(db, req.params.id);
      const preview = buildNextTaskRunPreview({
        db,
        taskId: taskRow.id,
        config: {
          ...(config || {}),
          dataDir: config?.dataDir || dataDir,
          repoRoot: config?.repoRoot || repoRoot,
        },
      });
      res.json({ preview });
    } catch (error) {
      if (error?.status) return sendRouteError(res, error);
      throw error;
    }
  });

  app.post("/api/tasks/:id/run", async (req, res) => {
    if (!watcher) return res.status(501).json({ error: { code: "not_configured", message: "watcher not wired" } });
    try {
      const taskRow = taskOr404(db, req.params.id);
      const result = await watcher.handleRunRequested(taskRow.id);
      res.json(result);
    } catch (err) {
      res.status(err.status || 400).json({ error: { code: err.code || "invalid_state", message: err.message } });
    }
  });

  app.post("/api/tasks/:id/cancel", (req, res) => {
    if (!watcher) return res.status(501).json({ error: { code: "not_configured", message: "watcher not wired" } });
    const taskRow = resolveTaskRow(db, req.params.id);
    if (!taskRow) return res.status(404).json({ error: { code: "not_found", message: "task not found" } });
    const taskId = taskRow.id;
    const cancelled = watcher.cancel(taskId);
    if (cancelled) return res.status(204).end();

    // No live worker — check for a stale `running` row left behind by a crashed
    // worker or coordinator restart. If found, reconcile so the UI can move on.
    const staleRun = db.prepare(
      `SELECT id, stage FROM task_runs
       WHERE task_id = ? AND status = 'running'
       ORDER BY started_at DESC LIMIT 1`
    ).get(taskId);
    if (!staleRun) return res.status(404).json({ error: { code: "not_running", message: "no active run" } });

    const now = Date.now();
    db.transaction(() => {
      db.prepare(
        `UPDATE task_runs
         SET status = 'error', process_status = 'abandoned', ended_at = ?,
             failure_kind = 'abandoned', error_text = ?
         WHERE id = ?`
      ).run(now, "worker exited", staleRun.id);
      const retryStage = staleRun.stage || "execute";
      db.prepare(
        `UPDATE tasks SET stage = CASE WHEN stage = 'done' THEN stage ELSE ? END,
                          error_text = COALESCE(error_text, ?),
                          stage_reason = COALESCE(stage_reason, 'abandoned'),
                          updated_at = ?
         WHERE id = ?`
      ).run(retryStage, "Previous run did not finish", now, taskId);
    })();

    broker.broadcast("global", buildRunLifecycleEvent(db, "run_ended", staleRun.id, {
      taskId,
      taskKey: taskRow.task_key || null,
    }));
    broker.broadcast("global", { type: "task_updated", id: taskId, taskKey: taskRow.task_key || null });
    res.status(204).end();
  });
}
