import {
  legacyRunStatusToProcessStatus,
  legacyStatusToStage,
  nextStage,
  processStatusToLegacyStatus,
  stageToLegacyStatus,
} from "../core/state-machine.js";
import { newRunId, newCommentId, newTaskId } from "../core/ids.js";
import { parseVerdict } from "../core/review.js";
import { synthesizeWorklabResult } from "../core/worklab-result.js";
import { parseModelReference } from "../core/ai.js";

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function taskStage(task) {
  return task?.stage || legacyStatusToStage(task?.status);
}

function runProcessStatus(runOrResult) {
  return runOrResult?.processStatus || legacyRunStatusToProcessStatus(runOrResult?.status);
}

function agentForStage(task, stage) {
  if (stage === "review") return task.reviewer_agent || task.owner_agent || task.executor_agent;
  return task.owner_agent || task.executor_agent;
}

function modeForStage(stage) {
  return stage === "review" ? "review" : "execute";
}

function buildFallbackResult({ stage, mode, res }) {
  if (stage === "review" || mode === "review") {
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
  return synthesizeWorklabResult({
    stage,
    decision: "advance",
    summary: res.finalText ? String(res.finalText).trim().slice(0, 500) : "Run completed",
    details: res.finalText || "",
  });
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
}) {
  const active = new Map();

  {
    const now = Date.now();
    const reconcile = db.transaction(() => {
      const stale = db.prepare(
        `SELECT id, task_id, stage FROM task_runs
         WHERE status = 'running'`,
      ).all();
      if (stale.length === 0) return 0;
      const markRun = db.prepare(
        `UPDATE task_runs
         SET process_status = 'abandoned', status = 'error', ended_at = ?,
             failure_kind = 'abandoned', error_text = ?
         WHERE id = ?`,
      );
      const markTask = db.prepare(
        `UPDATE tasks
         SET stage = CASE WHEN stage = 'done' THEN stage ELSE COALESCE(?, stage, 'execute') END,
             status = CASE WHEN stage = 'done' THEN 'done' ELSE ? END,
             error_text = COALESCE(error_text, ?),
             stage_reason = COALESCE(stage_reason, 'abandoned'),
             updated_at = ?
         WHERE id = ?`,
      );
      for (const row of stale) {
        const retryStage = row.stage || "execute";
        markRun.run(now, "coordinator restarted", row.id);
        markTask.run(retryStage, stageToLegacyStatus(retryStage), "Previous run did not finish", now, row.task_id);
      }
      return stale.length;
    });
    const count = reconcile();
    if (count > 0) logger?.warn?.({ count }, "reconciled stale running runs at boot");
  }

  const applyTx = db.transaction((taskId, sideEffects, currentStage, newStage, options = {}) => {
    const now = Date.now();
    const fields = [];
    const values = [];
    const running = !!options.running;

    if (currentStage !== newStage) {
      fields.push("stage = ?");
      values.push(newStage);
    }
    fields.push("status = ?");
    values.push(stageToLegacyStatus(newStage, { running }));

    for (const sideEffect of sideEffects) {
      switch (sideEffect.type) {
        case "set_completed_at":
          fields.push("completed_at = ?");
          values.push(now);
          break;
        case "clear_completed_at":
          fields.push("completed_at = ?");
          values.push(null);
          break;
        case "clear_error_text":
          fields.push("error_text = ?");
          values.push(null);
          break;
        case "set_error_text":
          fields.push("error_text = ?");
          values.push(sideEffect.message || "run failed");
          break;
        case "set_stage_reason":
          fields.push("stage_reason = ?");
          values.push(sideEffect.reason || null);
          break;
        case "clear_stage_reason":
          fields.push("stage_reason = ?");
          values.push(null);
          break;
        case "set_pending_actions":
          fields.push("pending_actions_json = ?");
          values.push(JSON.stringify(sideEffect.pendingActions || []));
          break;
        case "set_blocking_issues":
          fields.push("blocking_issues_json = ?");
          values.push(JSON.stringify(sideEffect.blockingIssues || []));
          break;
        case "post_error_comment":
          db.prepare(
            `INSERT INTO task_comments (id, task_id, author_type, body, created_at)
             VALUES (?, ?, 'system', ?, ?)`,
          ).run(newCommentId(), taskId, `ERROR: ${sideEffect.message || "run failed"}`, now);
          break;
        case "post_review_comment": {
          const body = sideEffect.notes && sideEffect.notes.trim().length > 0
            ? sideEffect.notes
            : "Review rejected.";
          db.prepare(
            `INSERT INTO task_comments (id, task_id, author_type, body, created_at)
             VALUES (?, ?, 'system', ?, ?)`,
          ).run(newCommentId(), taskId, body, now);
          break;
        }
        case "post_review_verdict":
          db.prepare(
            `INSERT INTO task_comments (id, task_id, author_type, body, created_at)
             VALUES (?, ?, 'system', ?, ?)`,
          ).run(newCommentId(), taskId, `VERDICT: ${sideEffect.verdict}`, now);
          break;
        case "spawn_worker":
        case "spawn_reviewer":
        case "create_subtasks":
          break;
        case "error":
          logger?.warn?.({ taskId, message: sideEffect.message }, "state machine emitted error side effect");
          break;
        default:
          logger?.warn?.({ taskId, type: sideEffect.type }, "unknown side effect type");
      }
    }

    fields.push("updated_at = ?");
    values.push(now);
    values.push(taskId);
    db.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  });

  function applySideEffects(taskId, sideEffects, currentStage, newStage, options = {}) {
    applyTx(taskId, sideEffects, currentStage, newStage, options);
    broker.broadcast("global", { type: "task_updated", id: taskId });
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
      WHERE d.task_id = ? AND COALESCE(t.stage, CASE t.status WHEN 'done' THEN 'done' ELSE 'execute' END) <> 'done'
      ORDER BY t.updated_at DESC
      LIMIT 1
    `).get(taskId);
  }

  function spawnRun({ task, stage, mode, agentName, parentRunId = null }) {
    const { providerKind } = assertAgentRunnable(agentName);
    const runId = newRunId();
    const now = Date.now();
    db.prepare(
      `INSERT INTO task_runs
        (id, task_id, parent_run_id, mode, stage, agent_name, provider_kind,
         started_at, status, process_status, retry_stage)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', 'running', ?)`,
    ).run(runId, task.id, parentRunId, mode, stage, agentName, providerKind, now, stage);

    const args = ["--task", task.id, "--mode", mode, "--agent", agentName];
    const env = {
      WORKLAB_RUN_ID: runId,
      WORKLAB_DATA_DIR: dataDir || "",
      WORKLAB_REPO_ROOT: repoRoot || "",
      WORKLAB_WORKSPACE: workspace || repoRoot || "",
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
    });

    db.prepare("UPDATE task_runs SET worker_pid = ? WHERE id = ?").run(handle.pid || null, runId);
    active.set(task.id, { runId, handle });
    broker.broadcast("global", { type: "run_started", runId, taskId: task.id });

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

  async function handleRunRequested(taskId, options = {}) {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    if (!task) throw new Error(`task ${taskId} not found`);
    if (active.has(taskId)) throw new Error("task already running");

    const stage = options.stage || taskStage(task);
    const blocker = hasOpenBlocker(taskId);
    if (blocker) throw new Error(`task is blocked by "${blocker.title}"`);

    const mode = options.mode || modeForStage(stage);
    const agentName = options.agentName || agentForStage(task, stage);
    if (!agentName) throw new Error(mode === "review" ? "no reviewer assigned" : "no executor assigned");

    const result = nextStage(stage, { type: "run_requested", stage, mode, agentName });
    const errorSideEffect = result.sideEffects.find((sideEffect) => sideEffect.type === "error");
    if (errorSideEffect) throw new Error(errorSideEffect.message);

    const run = spawnRun({ task, stage, mode, agentName, parentRunId: options.parentRunId || null });
    applySideEffects(taskId, result.sideEffects, stage, result.stage, { running: true });
    return run;
  }

  function spawnReviewer(taskId, reviewerAgent, priorRunId) {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    if (!task) return null;
    const stage = "review";
    db.prepare(
      "UPDATE tasks SET stage = 'review', status = 'in_progress', updated_at = ? WHERE id = ?",
    ).run(Date.now(), taskId);
    return spawnRun({ task: { ...task, stage }, stage, mode: "review", agentName: reviewerAgent, parentRunId: priorRunId });
  }

  function postAgentFinalComment(taskId, agentName, finalText) {
    if (!finalText) return;
    db.prepare(
      `INSERT INTO task_comments (id, task_id, author_type, author_id, body, created_at)
       VALUES (?, ?, 'agent', ?, ?, ?)`,
    ).run(newCommentId(), taskId, agentName, finalText, Date.now());
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

  function createDelegatedSubtasks(parentTask, runId, subtasks) {
    if (!Array.isArray(subtasks) || subtasks.length === 0) return [];
    const created = [];
    const byTitle = new Map();
    const rootTaskId = parentTask.root_task_id || parentTask.id;
    const now = Date.now();

    const tx = db.transaction(() => {
      for (let index = 0; index < subtasks.length; index += 1) {
        const subtask = subtasks[index] || {};
        if (!subtask.title || typeof subtask.title !== "string") continue;
        const suggested = subtask.suggested_agent || parentTask.owner_agent || parentTask.executor_agent;
        const agentExists = suggested
          ? db.prepare("SELECT name FROM agents WHERE name = ? AND enabled = 1").get(suggested)
          : null;
        const agentName = agentExists?.name || parentTask.owner_agent || parentTask.executor_agent;
        const childId = newTaskId();
        const required = subtask.required === false ? 0 : 1;
        db.prepare(`
          INSERT INTO tasks
            (id, root_task_id, parent_task_id, delegated_by_run_id, delegated_to_agent,
             owner_agent, title, instructions, status, stage, join_policy, subtask_order,
             required, executor_agent, reviewer_agent, tags, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'todo', 'execute', 'all_required', ?, ?, ?, ?, ?, ?, ?)
        `).run(
          childId,
          rootTaskId,
          parentTask.id,
          runId,
          agentName,
          agentName,
          subtask.title.trim(),
          subtask.instructions || "",
          index,
          required,
          agentName,
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
        created.push({ id: childId, required: !!required, agentName });
        byTitle.set(subtask.title.trim(), childId);
      }

      for (let index = 0; index < subtasks.length; index += 1) {
        const subtask = subtasks[index] || {};
        const child = created[index];
        if (!child) continue;
        for (const dep of subtask.depends_on || []) {
          const depId = byTitle.get(dep) || (created.find((entry) => entry.id === dep)?.id);
          if (!depId || depId === child.id) continue;
          db.prepare(`
            INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id, created_at)
            VALUES (?, ?, ?)
          `).run(child.id, depId, now);
        }
      }
    });
    tx();

    for (const child of created) broker.broadcast("global", { type: "task_created", id: child.id });
    return created;
  }

  function maybeRunDelegatedChildren(children) {
    for (const child of children) {
      const blocker = hasOpenBlocker(child.id);
      if (blocker || !child.agentName) continue;
      setTimeout(() => {
        handleRunRequested(child.id).catch((err) => {
          logger?.warn?.({ err, childId: child.id }, "delegated child auto-run failed");
        });
      }, 0);
    }
  }

  function maybeResumeWaitingParents(childTaskId) {
    const parents = db.prepare(`
      SELECT p.*
      FROM task_edges e
      JOIN tasks p ON p.id = e.parent_task_id
      WHERE e.child_task_id = ? AND e.edge_type = 'subtask'
    `).all(childTaskId);

    for (const parent of parents) {
      if (taskStage(parent) !== "awaiting_children") continue;
      const requiredChildren = db.prepare(`
        SELECT c.id, c.title, c.stage, c.status
        FROM task_edges e
        JOIN tasks c ON c.id = e.child_task_id
        WHERE e.parent_task_id = ? AND e.edge_type = 'subtask' AND e.required = 1
      `).all(parent.id);

      const blocked = requiredChildren.find((child) => taskStage(child) === "blocked");
      if (blocked) {
        const sm = nextStage("awaiting_children", {
          type: "child_blocked",
          message: `Required child blocked: ${blocked.title}`,
        });
        applySideEffects(parent.id, sm.sideEffects, "awaiting_children", sm.stage);
        continue;
      }

      if (requiredChildren.every((child) => taskStage(child) === "done")) {
        const sm = nextStage("awaiting_children", { type: "children_completed" });
        applySideEffects(parent.id, sm.sideEffects, "awaiting_children", sm.stage);
        setTimeout(() => {
          handleRunRequested(parent.id).catch((err) => {
            logger?.warn?.({ err, parentTaskId: parent.id }, "parent resume run failed");
          });
        }, 0);
      }
    }
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
    postAgentFinalComment(taskId, agentName, res.finalText);

    const next = nextStage(taskStage(task), {
      type: "run_succeeded",
      stage,
      result,
      reviewerAgent: task.reviewer_agent,
      nextStage: stage === "review" ? "done" : (task.parent_task_id && !task.reviewer_agent ? "done" : "review"),
    });
    const errorSideEffect = next.sideEffects.find((sideEffect) => sideEffect.type === "error");
    if (errorSideEffect) {
      logger?.error?.({ taskId, runId, message: errorSideEffect.message }, "illegal transition on run exit");
      return;
    }

    applySideEffects(taskId, next.sideEffects, taskStage(task), next.stage);

    const delegated = next.sideEffects.find((sideEffect) => sideEffect.type === "create_subtasks");
    if (delegated) {
      const children = createDelegatedSubtasks({ ...task, stage: next.stage }, runId, delegated.subtasks);
      maybeRunDelegatedChildren(children);
    }

    const reviewer = next.sideEffects.find((sideEffect) => sideEffect.type === "spawn_reviewer");
    if (reviewer) spawnReviewer(taskId, reviewer.agentName, runId);

    if (next.stage === "done" || next.stage === "blocked") maybeResumeWaitingParents(taskId);
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
    });
    applySideEffects(taskId, sm.sideEffects, taskStage(task), sm.stage);
    db.prepare(
      `UPDATE task_runs
       SET failure_kind = COALESCE(failure_kind, ?), retry_stage = COALESCE(retry_stage, ?)
       WHERE id = ?`,
    ).run(failureKind, stage, runId);
    if (sm.stage === "blocked") maybeResumeWaitingParents(taskId);
  }

  function onWorkerExit(taskId, runId, res) {
    const entry = active.get(taskId);
    if (entry?.runId === runId) active.delete(taskId);
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

    broker.broadcast("global", { type: "run_ended", runId, taskId });
  }

  function cancel(taskId) {
    const entry = active.get(taskId);
    if (!entry) return false;
    entry.handle.cancel();
    return true;
  }

  async function shutdown() {
    const promises = [];
    for (const entry of active.values()) {
      entry.handle.cancel();
      promises.push(entry.handle.done);
    }
    await Promise.allSettled(promises);
  }

  return {
    handleRunRequested,
    cancel,
    shutdown,
    isActive: (taskId) => active.has(taskId),
  };
}
