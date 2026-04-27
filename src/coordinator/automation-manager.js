import { createAutomationRunRows, createAutomationTriggerRow, nextAutomationStateAfterFire, nextFireAt, rowToAutomation } from "../core/automations.js";
import { parseModelReference } from "../core/ai.js";
import { nextStage, processStatusToLegacyStatus } from "../core/state-machine.js";
import { applyTaskSideEffects, taskStage } from "../core/task-side-effects.js";
import { newAutomationRunId } from "../core/ids.js";

const TICK_MS = 60_000;

function refreshEnabledAutomations(db, now = Date.now()) {
  const rows = db.prepare("SELECT * FROM automations WHERE enabled = 1 ORDER BY updated_at DESC").all();
  const update = db.prepare("UPDATE automations SET next_fire_at = ?, updated_at = ? WHERE id = ?");
  for (const row of rows) {
    const automation = rowToAutomation(row);
    const next = nextFireAt(automation.trigger, Math.max(now - 1000, automation.last_fired_at || 0));
    if (next !== automation.next_fire_at) update.run(next, now, automation.id);
  }
}

export function createAutomationManager({
  db,
  broker,
  spawn,
  watcher,
  workerBinary,
  logger,
  repoRoot,
  dataDir,
  workspace,
  cancelGraceMs = 5000,
  runTimeoutMs = 30 * 60 * 1000,
  runIdleWarningMs = 120 * 1000,
  logInlineLimit = 12_000,
} = {}) {
  const active = new Map();
  let interval = null;

  function assertAgentRunnable(agentName) {
    if (!agentName) throw new Error("agent is required");
    const agent = db.prepare("SELECT * FROM agents WHERE name = ?").get(agentName);
    if (!agent) throw new Error(`agent not found: ${agentName}`);
    if (!agent.enabled) throw new Error(`agent disabled: ${agentName}`);
    try {
      return { agent, providerKind: parseModelReference(agent.model).sdk };
    } catch (err) {
      throw new Error(`invalid agent model for ${agentName}: ${err.message}`);
    }
  }

  function activeRunForTask(taskId) {
    return db.prepare(`
      SELECT id
      FROM task_runs
      WHERE task_id = ? AND status = 'running'
      ORDER BY started_at DESC, rowid DESC
      LIMIT 1
    `).get(taskId);
  }

  function openBlockerForTask(taskId) {
    return db.prepare(`
      SELECT t.title
      FROM task_dependencies d
      JOIN tasks t ON t.id = d.depends_on_task_id
      WHERE d.task_id = ? AND COALESCE(t.stage, 'plan') <> 'done'
      ORDER BY t.updated_at DESC
      LIMIT 1
    `).get(taskId);
  }

  function agentForTaskStage(task, stage) {
    const runnableStage = stage === "done" ? "execute" : stage;
    return runnableStage === "review" ? task.reviewer_agent : task.owner_agent;
  }

  function applyAutomaticNextState(automation, now) {
    const next = nextAutomationStateAfterFire(automation, now);
    return {
      enabled: next.enabled ? 1 : 0,
      nextFireAt: next.next_fire_at,
    };
  }

  function updateAutomationAfterTrigger(automation, {
    triggerType,
    outcome,
    reason = null,
    runId = null,
    now = Date.now(),
  }) {
    createAutomationTriggerRow({ db, automation, triggerType, outcome, reason, runId, now });
    if (triggerType === "automatic") {
      const next = applyAutomaticNextState(automation, now);
      db.prepare(`
        UPDATE automations
        SET last_fired_at = ?, last_run_id = ?, last_status = ?,
            last_error = ?, enabled = ?, next_fire_at = ?, updated_at = ?
        WHERE id = ?
      `).run(now, runId, outcome, reason, next.enabled, next.nextFireAt, now, automation.id);
    } else {
      db.prepare(`
        UPDATE automations
        SET last_fired_at = ?, last_run_id = ?, last_status = ?,
            last_error = ?, updated_at = ?
        WHERE id = ?
      `).run(now, runId, outcome, reason, now, automation.id);
    }
  }

  function skipTaskAutomation(automation, triggerType, reason, now) {
    updateAutomationAfterTrigger(automation, {
      triggerType,
      outcome: "skipped",
      reason,
      now,
    });
    broker?.broadcast?.("global", {
      type: "automation_triggered",
      id: automation.id,
      taskId: automation.task_id || null,
      trigger: triggerType,
      outcome: "skipped",
      reason,
    });
    broker?.broadcast?.("global", { type: "automation_updated", id: automation.id, taskId: automation.task_id || null });
    if (automation.task_id) broker?.broadcast?.("global", { type: "task_updated", id: automation.task_id });
    return { skipped: true, reason };
  }

  function failTaskAutomation(automation, triggerType, reason, now) {
    updateAutomationAfterTrigger(automation, {
      triggerType,
      outcome: "failed",
      reason,
      now,
    });
    broker?.broadcast?.("global", {
      type: "automation_triggered",
      id: automation.id,
      taskId: automation.task_id || null,
      trigger: triggerType,
      outcome: "failed",
      reason,
    });
    broker?.broadcast?.("global", { type: "automation_updated", id: automation.id, taskId: automation.task_id || null });
    if (automation.task_id) broker?.broadcast?.("global", { type: "task_updated", id: automation.task_id });
    throw new Error(reason);
  }

  function reopenDoneTask(task, now) {
    const currentStage = taskStage(task);
    if (currentStage !== "done") return task;
    const result = nextStage(currentStage, {
      type: "human_move",
      target: "execute",
      reason: "scheduled automation",
    });
    const errorSideEffect = result.sideEffects.find((sideEffect) => sideEffect.type === "error");
    if (errorSideEffect) throw new Error(errorSideEffect.message);
    db.transaction(() => {
      applyTaskSideEffects(db, task.id, result.sideEffects, currentStage, result.stage, { now, logger });
    })();
    broker?.broadcast?.("global", { type: "task_updated", id: task.id });
    return db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id);
  }

  async function runTaskAutomation(automation, { triggerType = "manual", now = Date.now() } = {}) {
    if (!watcher?.handleRunRequested) throw new Error("task watcher not wired");
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(automation.task_id);
    if (!task) {
      const reason = `task ${automation.task_id} not found`;
      updateAutomationAfterTrigger(automation, { triggerType, outcome: "failed", reason, now });
      broker?.broadcast?.("global", { type: "automation_updated", id: automation.id, taskId: automation.task_id || null });
      throw new Error(reason);
    }

    if (watcher.isActive?.(task.id) || activeRunForTask(task.id)) {
      return skipTaskAutomation(automation, triggerType, "task already running", now);
    }

    const currentStage = taskStage(task);
    if (["blocked", "awaiting_children", "awaiting_user"].includes(currentStage)) {
      return skipTaskAutomation(automation, triggerType, `task is ${currentStage}`, now);
    }
    const blocker = openBlockerForTask(task.id);
    if (blocker) {
      return skipTaskAutomation(automation, triggerType, `task is blocked by "${blocker.title}"`, now);
    }
    if (!agentForTaskStage(task, currentStage)) {
      failTaskAutomation(
        automation,
        triggerType,
        currentStage === "review" ? "no reviewer assigned" : "no owner assigned",
        now,
      );
    }

    try {
      const runnableTask = reopenDoneTask(task, now);
      const run = await watcher.handleRunRequested(runnableTask.id);
      db.transaction(() => {
        db.prepare(`
          INSERT INTO automation_runs (id, automation_id, run_id, trigger_type, fired_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(newAutomationRunId(), automation.id, run.runId, triggerType, now);
        updateAutomationAfterTrigger(automation, {
          triggerType,
          outcome: "started",
          runId: run.runId,
          now,
        });
      })();
      broker?.broadcast?.("global", {
        type: "automation_triggered",
        id: automation.id,
        runId: run.runId,
        taskId: runnableTask.id,
        trigger: triggerType,
        outcome: "started",
      });
      broker?.broadcast?.("global", { type: "automation_updated", id: automation.id, taskId: runnableTask.id });
      broker?.broadcast?.("global", { type: "task_updated", id: runnableTask.id });
      return run;
    } catch (error) {
      updateAutomationAfterTrigger(automation, {
        triggerType,
        outcome: "failed",
        reason: error.message || String(error),
        now,
      });
      broker?.broadcast?.("global", { type: "automation_updated", id: automation.id, taskId: automation.task_id || null });
      broker?.broadcast?.("global", { type: "task_updated", id: task.id });
      throw error;
    }
  }

  function markSpawnFailed(automationId, runId, message, now = Date.now()) {
    db.prepare(`
      UPDATE task_runs
      SET status = ?, process_status = 'failed', ended_at = ?, failure_kind = 'spawn', error_text = ?
      WHERE id = ?
    `).run(processStatusToLegacyStatus("failed"), now, message, runId);
    db.prepare(`
      UPDATE automations
      SET last_status = 'failed', last_error = ?, updated_at = ?
      WHERE id = ?
    `).run(message, now, automationId);
    broker?.broadcast?.("global", { type: "run_ended", runId, taskId: null, automationId });
    broker?.broadcast?.("global", { type: "automation_updated", id: automationId });
  }

  function completeRun(automationId, runId, res) {
    active.delete(automationId);
    const status = res.processStatus || (res.status === "complete" ? "succeeded" : res.status) || "failed";
    const error = res.error || null;
    db.prepare(`
      UPDATE automations
      SET last_status = ?, last_error = ?, updated_at = ?
      WHERE id = ?
    `).run(status, error, Date.now(), automationId);
    broker?.broadcast?.("global", { type: "run_ended", runId, taskId: null, automationId });
    broker?.broadcast?.("global", { type: "automation_updated", id: automationId });
  }

  async function runNow(automationId, { triggerType = "manual", now = Date.now() } = {}) {
    const row = db.prepare("SELECT * FROM automations WHERE id = ?").get(automationId);
    if (!row) throw new Error(`automation ${automationId} not found`);
    if (active.has(automationId)) throw new Error("automation already running");
    const automation = rowToAutomation(row);
    if (automation.task_id) {
      return runTaskAutomation(automation, { triggerType, now });
    }
    const { providerKind } = assertAgentRunnable(automation.agent_name);

    const tx = db.transaction(() => {
      const run = createAutomationRunRows({ db, automation, triggerType, providerKind, now });
      createAutomationTriggerRow({ db, automation, triggerType, outcome: "started", runId: run.runId, now });
      if (triggerType === "automatic") {
        const next = nextAutomationStateAfterFire(automation, now);
        db.prepare(`
          UPDATE automations
          SET last_fired_at = ?, last_run_id = ?, last_status = 'running',
              last_error = NULL, enabled = ?, next_fire_at = ?, updated_at = ?
          WHERE id = ?
        `).run(now, run.runId, next.enabled ? 1 : 0, next.next_fire_at, now, automation.id);
      } else {
        db.prepare(`
          UPDATE automations
          SET last_fired_at = ?, last_run_id = ?, last_status = 'running',
              last_error = NULL, updated_at = ?
          WHERE id = ?
        `).run(now, run.runId, now, automation.id);
      }
      return run;
    });

    const { runId } = tx();
    try {
      const handle = spawn({
        binary: workerBinary,
        args: ["--mode", "automation", "--agent", automation.agent_name, "--automation", automation.id],
        env: {
          WORKLAB_RUN_ID: runId,
          WORKLAB_DATA_DIR: dataDir || "",
          WORKLAB_REPO_ROOT: repoRoot || "",
          WORKLAB_WORKSPACE: workspace || repoRoot || "",
        },
        runId,
        taskId: null,
        broker,
        db,
        logger,
        dataDir,
        cancelGraceMs,
        runTimeoutMs,
        runIdleWarningMs,
        logInlineLimit,
      });
      db.prepare("UPDATE task_runs SET worker_pid = ? WHERE id = ?").run(handle.pid || null, runId);
      active.set(automation.id, { runId, handle });
      broker?.broadcast?.("global", { type: "run_started", runId, taskId: null, mode: "automation", automationId: automation.id });
      broker?.broadcast?.("global", { type: "automation_triggered", id: automation.id, runId, trigger: triggerType });
      handle.done
        .then((res) => completeRun(automation.id, runId, res))
        .catch((err) => {
          logger?.error?.({ err, automationId: automation.id, runId }, "automation worker rejected");
          completeRun(automation.id, runId, { status: "error", processStatus: "failed", error: err.message });
        });
      return { runId };
    } catch (err) {
      markSpawnFailed(automation.id, runId, err.message || String(err), now);
      throw err;
    }
  }

  async function runDueAutomations(now = Date.now()) {
    const due = db.prepare(`
      SELECT * FROM automations
      WHERE enabled = 1 AND next_fire_at IS NOT NULL AND next_fire_at <= ?
      ORDER BY next_fire_at ASC, rowid ASC
    `).all(now);
    const started = [];
    for (const row of due) {
      try {
        const result = await runNow(row.id, { triggerType: "automatic", now });
        started.push({ automationId: row.id, runId: result.runId || null, skipped: !!result.skipped });
      } catch (error) {
        logger?.warn?.({ err: error.message, automationId: row.id }, "automation run failed to start");
      }
    }
    return { started, at: now };
  }

  function start() {
    if (interval) return;
    refreshEnabledAutomations(db);
    interval = setInterval(() => {
      runDueAutomations().catch((err) => logger?.warn?.({ err }, "automation tick failed"));
    }, TICK_MS);
    interval.unref?.();
  }

  async function shutdown() {
    if (interval) clearInterval(interval);
    interval = null;
    const waits = [];
    for (const entry of active.values()) {
      entry.handle.cancel();
      waits.push(entry.handle.done);
    }
    await Promise.allSettled(waits);
  }

  return {
    start,
    shutdown,
    tick: runDueAutomations,
    refresh: () => refreshEnabledAutomations(db),
    runNow,
    isActive: (automationId) => {
      if (active.has(automationId)) return true;
      return !!db.prepare(`
        SELECT r.id
        FROM automation_runs ar
        JOIN task_runs r ON r.id = ar.run_id
        WHERE ar.automation_id = ? AND r.status = 'running'
        LIMIT 1
      `).get(automationId);
    },
  };
}
