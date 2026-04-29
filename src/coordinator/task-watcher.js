import {
  DEFAULT_MAX_FAILURES,
  DEFAULT_MAX_REJECTIONS,
  legacyRunStatusToProcessStatus,
  nextStage,
  processStatusToLegacyStatus,
} from "../core/state-machine.js";
import { newRunId, newCommentId, newTaskId } from "../core/ids.js";
import { parseVerdict } from "../core/review.js";
import { formatWorklabResultText, stripWorklabResultJson, synthesizeWorklabResult } from "../core/worklab-result.js";
import { parseModelReference } from "../core/ai.js";
import { applyTaskSideEffects, taskStage } from "../core/task-side-effects.js";
import { resumeWaitingParents } from "../core/task-joins.js";
import { nextTaskKey, resolveTaskId } from "../core/task-keys.js";
import { readSettings } from "../core/settings.js";
import { supportsLiveInputProvider } from "../core/live-input.js";
import { buildRunLifecycleEvent } from "../core/run-events.js";
import { agentForTaskStage, missingAgentMessageForTaskStage } from "../core/task-agents.js";
import { prepareExecenv } from "../core/execenv.js";

function runProcessStatus(runOrResult) {
  return runOrResult?.processStatus || legacyRunStatusToProcessStatus(runOrResult?.status);
}

function safeParseJson(value, fallback) {
  try {
    const parsed = JSON.parse(value || "");
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function modeForStage(stage) {
  if (stage === "plan") return "plan";
  return stage === "review" ? "review" : "execute";
}

const AUTO_RUN_POLICY = "auto_plan_execute";

function buildFallbackResult({ stage, mode, res }) {
  if (stage === "review" || mode === "review") {
    // Worker's reviewResultFromText handles the verdict-line parse already; if
    // we still don't have a worklab_result here it means the reviewer emitted
    // neither valid JSON nor a usable VERDICT line. Returning null causes
    // handleSuccessfulExit to escalate via handleFailedExit (failure_kind
    // "invalid_result"). DO NOT synthesise an "advance" here — that would
    // silently approve the reviewer's broken output.
    const verdictEvent = Array.isArray(res.events)
      ? res.events.find((event) => event?.type === "verdict")
      : null;
    const verdict = verdictEvent?.verdict || parseVerdict(res.finalText).verdict;
    const notes = verdictEvent?.notes || parseVerdict(res.finalText).notes || "";
    if (verdict === "APPROVE") {
      return synthesizeWorklabResult({ stage: "review", decision: "approve", summary: notes || "Approved", details: res.finalText || "" });
    }
    if (verdict === "REJECT") {
      return synthesizeWorklabResult({ stage: "review", decision: "reject", summary: notes || "Rejected", details: res.finalText || "" });
    }
    return null;
  }
  if (!String(res.finalText || "").trim()) return null;
  return synthesizeWorklabResult({
    stage,
    decision: "advance",
    summary: res.finalText ? String(res.finalText).trim().slice(0, 500) : "Run completed",
    details: res.finalText || "",
  });
}

function collapseDuplicateParagraphs(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const paragraphs = raw.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  if (paragraphs.length <= 1) return raw;
  const seen = new Set();
  return paragraphs.filter((paragraph) => {
    const key = paragraph.replace(/\s+/g, " ");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join("\n\n");
}

function sanitizeAgentText(text) {
  return collapseDuplicateParagraphs(stripWorklabResultJson(text));
}

function structuredFinalText(result) {
  const value = result?.worklab_result || result;
  if (!value || value.schema !== "worklab.v2") return "";
  return sanitizeAgentText(value.final_text || "");
}

function agentCommentBody(result, finalText) {
  const structured = structuredFinalText(result);
  if (structured) return structured;
  const delivered = sanitizeAgentText(finalText);
  if (delivered) return delivered;
  return sanitizeAgentText(formatWorklabResultText(result));
}

function looksLikePlanBody(text) {
  const body = String(text || "").trim();
  if (!body) return false;
  return /^#{1,3}\s+Plan\b/im.test(body)
    || /^\*\*Plan\b/im.test(body)
    || /\b(?:Approach|Implementation|Test Plan|Risks?|Caveats?|Out of scope)\b/i.test(body);
}

// In-memory cycle check across a freshly-delegated batch of subtasks. Each
// subtask references siblings by title (or by external task id, which we
// ignore for the within-batch cycle check). DFS with three-color marks.
function detectSubtaskCycles(subtasks) {
  const titleToIndex = new Map();
  subtasks.forEach((subtask, index) => {
    const title = (subtask?.title || "").trim();
    if (title) titleToIndex.set(title, index);
  });
  const graph = subtasks.map((subtask) => {
    const deps = Array.isArray(subtask?.depends_on) ? subtask.depends_on : [];
    return deps
      .map((dep) => titleToIndex.get((dep || "").trim()))
      .filter((index) => typeof index === "number");
  });
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Array(subtasks.length).fill(WHITE);
  function visit(i) {
    if (color[i] === GRAY) return true;
    if (color[i] === BLACK) return false;
    color[i] = GRAY;
    for (const j of graph[i]) if (visit(j)) return true;
    color[i] = BLACK;
    return false;
  }
  for (let i = 0; i < subtasks.length; i += 1) {
    if (color[i] === WHITE && visit(i)) return true;
  }
  return false;
}

export function createTaskWatcher({
  db,
  broker,
  spawn,
  workerBinary,
  logger,
  repoRoot,
  dataDir,
  workspace,
  runTimeoutMs = 30 * 60 * 1000,
  runIdleWarningMs = 120 * 1000,
  logInlineLimit = 12_000,
  maxFailures = null,
  events,
}) {
  const active = new Map();
  const activeByRunId = new Map();
  // Tasks for which an auto-start has been scheduled (via setTimeout) but the
  // worker has not yet been spawned. Prevents duplicate kicks when sibling
  // children complete in the same tick or a child finishes during a fresh
  // delegation round.
  const pendingStarts = new Set();

  function canAutoStart(taskId) {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    if (!task) return false;
    const stage = taskStage(task);
    if (task.run_policy !== AUTO_RUN_POLICY) return false;
    if (!["plan", "execute", "review"].includes(stage)) return false;
    if (!agentForTaskStage(task, stage)) return false;
    if (active.has(taskId) || pendingStarts.has(taskId)) return false;
    if (hasOpenBlocker(taskId)) return false;
    return true;
  }

  function scheduleAutoStart(taskId, onError) {
    if (!canAutoStart(taskId)) return;
    if (active.has(taskId) || pendingStarts.has(taskId)) return;
    pendingStarts.add(taskId);
    setTimeout(() => {
      pendingStarts.delete(taskId);
      if (!canAutoStart(taskId)) return;
      handleRunRequested(taskId).catch(onError);
    }, 0);
  }

  function maybeAutoStartTask(taskId, onError) {
    scheduleAutoStart(taskId, onError || ((err) => {
      logger?.warn?.({ err, taskId }, "task auto-run failed");
      annotateTaskFailure(taskId, { message: `Auto-run failed: ${err.message}`, failureKind: "spawn" });
    }));
  }

  function maybeAutoStartDependents(taskId, onError) {
    const rows = db.prepare(`
      SELECT task_id
      FROM task_dependencies
      WHERE depends_on_task_id = ?
      ORDER BY created_at ASC
    `).all(taskId);
    for (const row of rows) {
      scheduleAutoStart(row.task_id, onError || ((err) => {
        logger?.warn?.({ err, taskId: row.task_id, dependencyId: taskId }, "dependent task auto-run failed");
        annotateTaskFailure(row.task_id, { message: `Auto-run failed: ${err.message}`, failureKind: "spawn" });
      }));
    }
  }

  {
    const now = Date.now();
    const reconcile = db.transaction(() => {
      const stale = db.prepare(
        `SELECT id, task_id, stage FROM task_runs
         WHERE process_status = 'running' OR status = 'running'`,
      ).all();
      if (stale.length === 0) return 0;
      const markRun = db.prepare(
        `UPDATE task_runs
         SET process_status = 'abandoned', status = 'error', ended_at = ?,
             failure_kind = 'abandoned', error_text = ?,
             cancel_initiator = COALESCE(cancel_initiator, 'stale_reconcile'),
             cancel_reason = COALESCE(cancel_reason, 'coordinator restarted while run was active')
         WHERE id = ?`,
      );
      const markTask = db.prepare(
        `UPDATE tasks
         SET stage = CASE WHEN stage = 'done' THEN stage ELSE COALESCE(?, stage, 'plan') END,
             error_text = COALESCE(error_text, ?),
             stage_reason = COALESCE(stage_reason, 'abandoned'),
             updated_at = ?
         WHERE id = ?`,
      );
      for (const row of stale) {
        const retryStage = row.stage || "plan";
        markRun.run(now, "coordinator restarted", row.id);
        markTask.run(retryStage, "Previous run did not finish", now, row.task_id);
      }
      return stale.length;
    });
    const count = reconcile();
    if (count > 0) logger?.warn?.({ count }, "reconciled stale running runs at boot");
  }

  // Apply a list of side-effects to the DB inside a single transaction, plus
  // associated task-comments. spawn_worker / spawn_reviewer / create_subtasks
  // are owned by the caller (they need spawn machinery / DB writes outside
  // this transaction) and are handled as no-ops here.
  const applyTx = db.transaction((taskId, sideEffects, currentStage, newStage, options = {}) => {
    applyTaskSideEffects(db, taskId, sideEffects, currentStage, newStage, { logger });
  });

  function maxFailureLimit() {
    const settings = readSettings(db);
    return Number(maxFailures ?? settings.max_failure_streak ?? DEFAULT_MAX_FAILURES);
  }

  function maxRejectionLimit() {
    const settings = readSettings(db);
    return Number(settings.max_rejection_streak ?? DEFAULT_MAX_REJECTIONS);
  }

  function applySideEffects(taskId, sideEffects, currentStage, newStage, options = {}) {
    applyTx(taskId, sideEffects, currentStage, newStage, options);
    broker.broadcast("global", { type: "task_updated", id: taskId });
  }

  function annotateTaskFailure(taskId, { message, failureKind = "spawn", retryStage }) {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    if (!task) return;
    const stage = retryStage || taskStage(task);
    const next = nextStage(taskStage(task), {
      type: "run_failed",
      retryStage: stage,
      failureKind,
      message,
      failureCount: task.retry_count || 0,
      maxFailures: maxFailureLimit(),
    });
    applySideEffects(taskId, next.sideEffects, taskStage(task), next.stage);
  }

  function assertAgentRunnable(agentName) {
    const agent = db.prepare("SELECT * FROM agents WHERE name = ?").get(agentName);
    if (!agent) throw new Error(`agent not found: ${agentName}`);
    if (!agent.enabled) throw new Error(`agent disabled: ${agentName}`);
    try {
      return { agent, providerKind: parseModelReference(agent.model).sdk };
    } catch (err) {
      throw new Error(`invalid agent model for ${agentName}: ${err.message}`);
    }
  }

  function hasOpenBlocker(taskId) {
    return db.prepare(`
      SELECT t.id, t.title
      FROM task_dependencies d
      JOIN tasks t ON t.id = d.depends_on_task_id
      WHERE d.task_id = ? AND COALESCE(t.stage, 'plan') <> 'done'
      ORDER BY t.updated_at DESC
      LIMIT 1
    `).get(taskId);
  }

  function latestPriorExecuteRunId(taskId) {
    return db.prepare(`
      SELECT id
      FROM task_runs
      WHERE task_id = ?
        AND mode = 'execute'
      ORDER BY ended_at DESC, started_at DESC, rowid DESC
      LIMIT 1
    `).get(taskId)?.id || null;
  }

  function spawnRun({ task, stage, mode, agentName, parentRunId = null }) {
    const { providerKind } = assertAgentRunnable(agentName);
    const settings = readSettings(db);
    const runId = newRunId();
    const now = Date.now();
    db.prepare(
      `INSERT INTO task_runs
        (id, task_id, parent_run_id, mode, stage, agent_name, provider_kind,
         started_at, status, process_status, retry_stage)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', 'running', ?)`,
    ).run(runId, task.id, parentRunId, mode, stage, agentName, providerKind, now, stage);

    let execenvPath = null;
    if (dataDir) {
      try {
        const env = prepareExecenv({ dataDir, runId, agent: { name: agentName }, task, providerKind });
        execenvPath = env.root;
        db.prepare("UPDATE task_runs SET execenv_path = ? WHERE id = ?").run(execenvPath, runId);
      } catch (err) {
        logger?.warn?.({ err: err.message, runId }, "execenv preparation failed");
      }
    }

    const args = ["--task", task.id, "--mode", mode, "--agent", agentName];
    const env = {
      WORKLAB_RUN_ID: runId,
      WORKLAB_DATA_DIR: dataDir || "",
      WORKLAB_REPO_ROOT: repoRoot || "",
      WORKLAB_WORKSPACE: workspace || repoRoot || "",
      ...(execenvPath ? { WORKLAB_EXECENV_PATH: execenvPath } : {}),
    };
    if (mode === "review" && parentRunId) env.WORKLAB_PRIOR_RUN_ID = parentRunId;

    const handle = spawn({
      binary: workerBinary,
      args,
      env,
      runId,
      taskId: task.id,
      broker,
      db,
      logger,
      dataDir,
      cancelGraceMs: settings.cancel_grace_ms,
      runTimeoutMs: settings.worker_timeout_ms || runTimeoutMs,
      runIdleWarningMs,
      logInlineLimit,
    });

    db.prepare("UPDATE task_runs SET worker_pid = ? WHERE id = ?").run(handle.pid || null, runId);
    active.set(task.id, { runId, handle });
    activeByRunId.set(runId, { taskId: task.id, handle, providerKind });
    broker.broadcast("global", buildRunLifecycleEvent(db, "run_started", runId, { taskId: task.id }));

    handle.done
      .then((result) => onWorkerExit(task.id, runId, result))
      .catch((err) => {
        logger?.error?.({ err, taskId: task.id, runId }, "worker promise rejected");
        onWorkerExit(task.id, runId, {
          exitCode: 1,
          status: "error",
          processStatus: "failed",
          error: err.message,
        });
      });

    return { runId };
  }

  function checkBudget({ agentName, taskId }) {
    const settings = readSettings(db);
    const agent = db.prepare("SELECT daily_budget_usd, per_run_budget_usd FROM agents WHERE name = ?").get(agentName);
    const startOfDayUtc = new Date();
    startOfDayUtc.setUTCHours(0, 0, 0, 0);
    const since = startOfDayUtc.getTime();
    const todayCostRow = db.prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) AS total
      FROM task_runs
      WHERE agent_name = ? AND started_at >= ? AND cost_usd IS NOT NULL
    `).get(agentName, since);
    const workspaceCostRow = db.prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) AS total
      FROM task_runs
      WHERE started_at >= ? AND cost_usd IS NOT NULL
    `).get(since);
    const agentSpend = Number(todayCostRow?.total || 0);
    const workspaceSpend = Number(workspaceCostRow?.total || 0);
    const workspaceBudget = Number(settings.daily_budget_usd || 0);
    if (workspaceBudget > 0 && workspaceSpend >= workspaceBudget) {
      return {
        ok: false,
        scope: "workspace",
        spent: workspaceSpend,
        cap: workspaceBudget,
        message: `Daily workspace budget reached ($${workspaceSpend.toFixed(4)} of $${workspaceBudget.toFixed(2)}).`,
      };
    }
    const agentDailyBudget = Number(agent?.daily_budget_usd || 0);
    if (agentDailyBudget > 0 && agentSpend >= agentDailyBudget) {
      return {
        ok: false,
        scope: "agent_daily",
        spent: agentSpend,
        cap: agentDailyBudget,
        message: `Daily budget for ${agentName} reached ($${agentSpend.toFixed(4)} of $${agentDailyBudget.toFixed(2)}).`,
      };
    }
    return { ok: true, agentSpend, workspaceSpend };
  }

  function recordPerRunBudgetOverage({ runId, agentName, costUsd }) {
    const cost = Number(costUsd);
    if (!Number.isFinite(cost)) return;
    const agent = db.prepare("SELECT per_run_budget_usd FROM agents WHERE name = ?").get(agentName);
    const cap = Number(agent?.per_run_budget_usd || 0);
    if (!(cap > 0) || cost <= cap) {
      db.prepare("UPDATE task_runs SET cost_usd = COALESCE(cost_usd, ?) WHERE id = ?").run(cost, runId);
      return;
    }

    const row = db.prepare("SELECT warnings_json, diagnostics_json FROM task_runs WHERE id = ?").get(runId);
    if (!row) return;
    const warning = {
      kind: "budget_exceeded",
      source: "budget",
      message: `Run cost $${cost.toFixed(4)} exceeded per-run budget $${cap.toFixed(2)} for ${agentName}.`,
    };
    const warnings = safeParseJson(row.warnings_json, []);
    const diagnostics = safeParseJson(row.diagnostics_json, {});
    warnings.push(warning);
    db.prepare(`
      UPDATE task_runs
      SET cost_usd = COALESCE(cost_usd, ?),
          warnings_json = ?,
          diagnostics_json = ?
      WHERE id = ?
    `).run(
      cost,
      JSON.stringify(warnings),
      JSON.stringify({
        ...(diagnostics && typeof diagnostics === "object" && !Array.isArray(diagnostics) ? diagnostics : {}),
        per_run_budget_exceeded: true,
        per_run_budget_usd: cap,
        cost_usd: cost,
      }),
      runId,
    );
  }

  async function handleRunRequested(taskId, options = {}) {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    if (!task) throw new Error(`task ${taskId} not found`);
    if (active.has(taskId)) throw new Error("task already running");

    const stage = options.stage || taskStage(task);
    const blocker = hasOpenBlocker(taskId);
    if (blocker) throw new Error(`task is blocked by "${blocker.title}"`);

    const mode = options.mode || modeForStage(stage);
    const agentName = options.agentName || agentForTaskStage(task, stage);
    if (!agentName) throw new Error(missingAgentMessageForTaskStage(stage));

    const result = nextStage(stage, { type: "run_requested", stage, mode, agentName });
    const errorSideEffect = result.sideEffects.find((sideEffect) => sideEffect.type === "error");
    if (errorSideEffect) throw new Error(errorSideEffect.message);

    const parentRunId = options.parentRunId || (mode === "review" ? latestPriorExecuteRunId(taskId) : null);
    if (mode === "review" && !parentRunId) throw new Error("no execute run to review");

    if (mode === "review") {
      const reviewerCheck = enforceNoSelfReview({ taskId, reviewerAgent: agentName });
      if (!reviewerCheck.ok) {
        const err = new Error(reviewerCheck.message);
        err.code = "self_review_disallowed";
        throw err;
      }
    }

    if (!options.skipBudgetCheck) {
      const budget = checkBudget({ agentName, taskId });
      if (!budget.ok) {
        annotateTaskFailure(taskId, {
          message: budget.message,
          failureKind: "budget_exceeded",
          retryStage: stage,
        });
        const err = new Error(budget.message);
        err.code = "budget_exceeded";
        throw err;
      }
    }

    const run = spawnRun({ task, stage, mode, agentName, parentRunId });
    applySideEffects(taskId, result.sideEffects, stage, result.stage, { running: true });
    return run;
  }

  function enforceNoSelfReview({ taskId, reviewerAgent }) {
    const reviewer = db.prepare("SELECT allow_self_review FROM agents WHERE name = ?").get(reviewerAgent);
    if (reviewer?.allow_self_review) return { ok: true };
    const lastExecutor = db.prepare(`
      SELECT agent_name
      FROM task_runs
      WHERE task_id = ? AND mode = 'execute'
      ORDER BY started_at DESC, rowid DESC
      LIMIT 1
    `).get(taskId);
    if (!lastExecutor) return { ok: true };
    if (lastExecutor.agent_name === reviewerAgent) {
      return {
        ok: false,
        message: `${reviewerAgent} cannot review their own execute run; assign a different reviewer or enable allow_self_review on the agent.`,
      };
    }
    return { ok: true };
  }

  function postAgentFinalComment(taskId, agentName, result, finalText) {
    const body = agentCommentBody(result, finalText);
    if (!body) return;
    db.prepare(
      `INSERT INTO task_comments (id, task_id, author_type, author_id, body, created_at)
       VALUES (?, ?, 'agent', ?, ?, ?)`,
    ).run(newCommentId(), taskId, agentName, body, Date.now());
  }

  function updateRunResult(runId, result) {
    if (!result) return;
    db.prepare(
      `UPDATE task_runs
       SET decision = ?, summary = COALESCE(summary, ?), details = COALESCE(details, ?),
           result_json = COALESCE(result_json, ?)
       WHERE id = ?`,
    ).run(result.decision || null, result.summary || null, result.details || null, JSON.stringify(result), runId);
  }

  function planBodyFromRun(result, finalText) {
    const rawPlan = sanitizeAgentText(finalText);
    if (looksLikePlanBody(rawPlan)) return rawPlan;
    for (const candidate of [result?.details, result?.summary, rawPlan]) {
      const body = sanitizeAgentText(candidate);
      if (body) return body;
    }
    return "";
  }

  function planBodySideEffect(runId, agentName, result, finalText) {
    const body = planBodyFromRun(result, finalText);
    if (!body) return null;
    return {
      type: "set_plan_body",
      body,
      runId,
      updatedBy: agentName || "agent",
    };
  }

  function postSystemComment(taskId, body) {
    db.prepare(
      `INSERT INTO task_comments (id, task_id, author_type, body, created_at)
       VALUES (?, ?, 'system', ?, ?)`,
    ).run(newCommentId(), taskId, body, Date.now());
  }

  function createDelegatedSubtasks(parentTask, runId, subtasks) {
    if (!Array.isArray(subtasks) || subtasks.length === 0) return [];

    if (detectSubtaskCycles(subtasks)) {
      postSystemComment(parentTask.id, "Delegation rejected: subtasks form a dependency cycle.");
      return [];
    }

    const created = [];
    const byTitle = new Map();
    const rootTaskId = parentTask.root_task_id || parentTask.id;
    const now = Date.now();
    const warnings = [];

    const tx = db.transaction(() => {
      // Supersede prior delegation: drop old subtask edges so
      // maybeResumeWaitingParents only tracks the current round.
      db.prepare(
        "DELETE FROM task_edges WHERE parent_task_id = ? AND edge_type = 'subtask'",
      ).run(parentTask.id);

      for (let index = 0; index < subtasks.length; index += 1) {
        const subtask = subtasks[index] || {};
        if (!subtask.title || typeof subtask.title !== "string") continue;
        const suggested = subtask.suggested_agent || parentTask.owner_agent;
        const agentExists = suggested
          ? db.prepare("SELECT name FROM agents WHERE name = ? AND enabled = 1").get(suggested)
          : null;
        const agentName = agentExists?.name || parentTask.owner_agent;
        if (subtask.suggested_agent && !agentExists) {
          warnings.push(`Subtask "${subtask.title.trim()}": suggested agent "${subtask.suggested_agent}" not found or disabled — falling back to "${agentName || "(none)"}".`);
        }
        const childId = newTaskId();
        const taskKey = nextTaskKey(db);
        const required = subtask.required === false ? 0 : 1;
        db.prepare(`
          INSERT INTO tasks
            (id, task_key, root_task_id, parent_task_id, delegated_by_run_id, delegated_to_agent,
             owner_agent, title, instructions, stage, run_policy, join_policy, subtask_order,
             required, reviewer_agent, tags, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'execute', ?, 'all_required', ?, ?, ?, ?, ?, ?)
        `).run(
          childId,
          taskKey,
          rootTaskId,
          parentTask.id,
          runId,
          agentName,
          agentName,
          subtask.title.trim(),
          subtask.instructions || "",
          parentTask.run_policy || "manual",
          index,
          required,
          parentTask.reviewer_agent || null,
          JSON.stringify(["delegated"]),
          now,
          now,
        );
        db.prepare(`
          INSERT INTO task_edges
            (parent_task_id, child_task_id, edge_type, required, created_by_run_id, created_at)
          VALUES (?, ?, 'subtask', ?, ?, ?)
        `).run(parentTask.id, childId, required, runId, now);
        created.push({ id: childId, taskKey, title: subtask.title.trim(), required: !!required, agentName });
        byTitle.set(subtask.title.trim(), childId);
      }

      for (let index = 0; index < subtasks.length; index += 1) {
        const subtask = subtasks[index] || {};
        const child = created[index];
        if (!child) continue;
        for (const dep of subtask.depends_on || []) {
          const trimmed = (dep || "").trim?.() || dep;
          let depId = byTitle.get(trimmed);
          if (!depId) {
            // Allow referring to an existing task by id (sibling created in
            // this batch already covered above; this handles cross-batch).
            depId = resolveTaskId(db, trimmed);
          }
          if (!depId || depId === child.id) {
            warnings.push(`Subtask "${subtask.title || "?"}": depends_on "${dep}" did not resolve and was dropped.`);
            continue;
          }
          db.prepare(`
            INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id, created_at)
            VALUES (?, ?, ?)
          `).run(child.id, depId, now);
        }
      }
    });
    tx();

    if (warnings.length > 0) {
      postSystemComment(parentTask.id, `Delegation warnings:\n- ${warnings.join("\n- ")}`);
    }
    if (created.length > 0) {
      const lines = created.map((child) => `- ${child.taskKey}: ${child.title} (${child.agentName || "unassigned"}${child.required ? ", required" : ", optional"})`);
      postSystemComment(parentTask.id, `Delegated ${created.length} subtask${created.length === 1 ? "" : "s"}:\n${lines.join("\n")}`);
    }

    for (const child of created) broker.broadcast("global", { type: "task_created", id: child.id });
    return created;
  }

  function maybeRunDelegatedChildren(children) {
    for (const child of children) {
      scheduleAutoStart(child.id, (err) => {
        logger?.warn?.({ err, childId: child.id }, "delegated child auto-run failed");
        annotateTaskFailure(child.id, { message: `Auto-start failed: ${err.message}`, failureKind: "spawn", retryStage: "execute" });
      });
    }
  }

  function maybeResumeWaitingParents(childTaskId) {
    resumeWaitingParents({
      db,
      childTaskId,
      applySideEffects,
      onParentReady: (parentId) => {
        scheduleAutoStart(parentId, (err) => {
          logger?.warn?.({ err, parentTaskId: parentId }, "parent resume run failed");
          annotateTaskFailure(parentId, { message: `Parent resume failed: ${err.message}`, failureKind: "spawn", retryStage: "execute" });
        });
      },
    });
  }

  function handleSuccessfulExit(taskId, runId, res, task, run) {
    const stage = run.stage || taskStage(task);
    const mode = run.mode || modeForStage(stage);
    const agentName = run.agent_name;
    const result = res.worklabResult || buildFallbackResult({ stage, mode, res });

    if (!result) {
      handleFailedExit(taskId, runId, {
        ...res,
        error: "invalid worklab_result",
        processStatus: "failed",
        failureKind: "invalid_result",
      }, task, run);
      return;
    }

    updateRunResult(runId, result);
    postAgentFinalComment(taskId, agentName, result, res.finalText);

    const next = nextStage(taskStage(task), {
      type: "run_succeeded",
      stage,
      result,
      reviewerAgent: stage === "review" ? null : (task.reviewer_agent || null),
      rejectionCount: task.rejection_streak || 0,
      maxRejections: maxRejectionLimit(),
    });
    const errorSideEffect = next.sideEffects.find((sideEffect) => sideEffect.type === "error");
    if (errorSideEffect) {
      logger?.error?.({ taskId, runId, message: errorSideEffect.message }, "illegal transition on run exit");
      annotateTaskFailure(taskId, {
        message: errorSideEffect.message,
        failureKind: "invalid_result",
        retryStage: stage,
      });
      return;
    }

    let sideEffects = next.sideEffects;
    if (stage === "plan") {
      const planSideEffect = planBodySideEffect(runId, agentName, result, res.finalText);
      if (planSideEffect) sideEffects = [planSideEffect, ...sideEffects];
    }

    applySideEffects(taskId, sideEffects, taskStage(task), next.stage);

    const delegated = next.sideEffects.find((sideEffect) => sideEffect.type === "create_subtasks");
    if (delegated) {
      const children = createDelegatedSubtasks({ ...task, stage: next.stage }, runId, delegated.subtasks);
      maybeRunDelegatedChildren(children);
    }

    if (next.stage === "done" || next.stage === "blocked") maybeResumeWaitingParents(taskId);
    if (next.stage === "done") maybeAutoStartDependents(taskId);
    if (["plan", "execute", "review"].includes(next.stage)) maybeAutoStartTask(taskId);
  }

  function handleFailedExit(taskId, runId, res, task, run) {
    const processStatus = runProcessStatus(res);
    const stage = run.stage || taskStage(task);
    const failureKind = res.failureKind || res.failure_kind || (processStatus === "cancelled" ? "cancelled" : "spawn");
    const eventType = processStatus === "cancelled"
      ? "run_cancelled"
      : processStatus === "abandoned"
        ? "run_abandoned"
        : "run_failed";
    const sm = nextStage(taskStage(task), {
      type: eventType,
      retryStage: stage,
      failureKind,
      message: res.error || (processStatus === "cancelled" ? "Run cancelled." : "run failed"),
      failureCount: task.retry_count || 0,
      maxFailures: maxFailureLimit(),
      cancelInitiator: res.cancelInitiator || res.cancel_initiator || null,
      cancelReason: res.cancelReason || res.cancel_reason || null,
    });
    applySideEffects(taskId, sm.sideEffects, taskStage(task), sm.stage);
    db.prepare(
      `UPDATE task_runs
       SET failure_kind = COALESCE(failure_kind, ?), retry_stage = COALESCE(retry_stage, ?)
       WHERE id = ?`,
    ).run(failureKind, stage, runId);
    // Wake parents on every child terminal-ish exit. maybeResumeWaitingParents
    // is idempotent and per-child only fires when the child is `blocked` or
    // all required children are `done`, so this is safe even when the child
    // remains at `execute` after a cancel.
    maybeResumeWaitingParents(taskId);
  }

  function onWorkerExit(taskId, runId, res) {
    const entry = active.get(taskId);
    if (entry?.runId === runId) active.delete(taskId);
    activeByRunId.delete(runId);
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    if (!task) return;
    const run = db.prepare("SELECT * FROM task_runs WHERE id = ?").get(runId);
    if (!run) return;

    const processStatus = runProcessStatus(res);
    if (processStatus === "succeeded" || res.status === "complete") {
      handleSuccessfulExit(taskId, runId, res, task, run);
    } else {
      handleFailedExit(taskId, runId, res, task, run);
    }
    recordPerRunBudgetOverage({ runId, agentName: run.agent_name, costUsd: res.costUsd ?? res.cost_usd });

    const endedEvent = buildRunLifecycleEvent(db, "run_ended", runId, { taskId });
    broker.broadcast("global", endedEvent);
    events?.emit?.("run:ended", endedEvent);
  }

  function cancel(taskId, options = {}) {
    const entry = active.get(taskId);
    if (!entry) return false;
    entry.handle.cancel({
      initiator: options.initiator || "user",
      reason: options.reason || null,
    });
    return true;
  }

  function getRunLiveInputState(runId) {
    const run = db.prepare("SELECT id, process_status, status, provider_kind FROM task_runs WHERE id = ?").get(runId);
    if (!run) return { supported: false, active: false, reason: "not_found" };
    if (!supportsLiveInputProvider(run.provider_kind)) {
      return { supported: false, active: false, reason: "unsupported_provider" };
    }
    const entry = activeByRunId.get(runId);
    return {
      supported: true,
      active: !!entry,
      reason: entry ? null : "not_active",
    };
  }

  async function sendRunMessage(runId, message) {
    const entry = activeByRunId.get(runId);
    if (!entry) {
      return { ok: false, code: "run_not_active", message: "run is not active" };
    }
    if (!supportsLiveInputProvider(entry.providerKind)) {
      return { ok: false, code: "live_input_unsupported", message: "live input is not supported for this provider" };
    }
    if (typeof entry.handle?.sendLiveMessage !== "function") {
      return { ok: false, code: "live_input_unavailable", message: "worker does not accept live input" };
    }
    return entry.handle.sendLiveMessage(message);
  }

  async function shutdown() {
    const promises = [];
    for (const entry of active.values()) {
      entry.handle.cancel({
        initiator: "coordinator_shutdown",
        reason: "coordinator stopping",
      });
      promises.push(entry.handle.done);
    }
    await Promise.allSettled(promises);
  }

  return {
    handleRunRequested,
    cancel,
    shutdown,
    isActive: (taskId) => active.has(taskId),
    isRunActive: (runId) => activeByRunId.has(runId),
    getRunLiveInputState,
    sendRunMessage,
    maybeAutoStart: maybeAutoStartTask,
    maybeAutoStartDependents,
  };
}
