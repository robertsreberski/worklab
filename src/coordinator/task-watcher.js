import { nextStatus } from "../core/state-machine.js";
import { newRunId, newCommentId } from "../core/ids.js";
import { parseVerdict } from "../core/review.js";

export function createTaskWatcher({
  db,
  broker,
  spawn,
  workerBinary,
  logger,
  repoRoot,
  dataDir,
}) {
  const active = new Map();

  /**
   * Apply a list of side effects to the DB and post derived system comments.
   * Does NOT handle spawn_executor / spawn_reviewer — those require spawn
   * machinery and are orchestrated by the caller.
   */
  function applySideEffects(taskId, sideEffects, currentStatus, newStatus) {
    const now = Date.now();
    const fields = [];
    const values = [];
    if (currentStatus !== newStatus) {
      fields.push("status = ?");
      values.push(newStatus);
    }
    for (const se of sideEffects) {
      switch (se.type) {
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
          values.push(se.message || "run failed");
          break;
        case "post_error_comment":
          db.prepare(
            `INSERT INTO task_comments (id, task_id, author_type, body, created_at) VALUES (?, ?, 'system', ?, ?)`,
          ).run(newCommentId(), taskId, `ERROR: ${se.message || "run failed"}`, now);
          break;
        case "post_review_comment": {
          const body = se.notes && se.notes.trim().length > 0 ? se.notes : "Review rejected.";
          db.prepare(
            `INSERT INTO task_comments (id, task_id, author_type, body, created_at) VALUES (?, ?, 'system', ?, ?)`,
          ).run(newCommentId(), taskId, body, now);
          break;
        }
        case "mark_badge_red":
          // UI-layer signal — derived from presence of error_text. No-op here.
          break;
        case "spawn_executor":
        case "spawn_reviewer":
          // Handled by caller (handleRunRequested / onWorkerExit).
          break;
        case "error":
          logger?.warn?.({ taskId, message: se.message }, "state machine emitted error side effect");
          break;
        default:
          logger?.warn?.({ taskId, type: se.type }, "unknown side effect type");
      }
    }
    if (fields.length > 0) {
      fields.push("updated_at = ?");
      values.push(now);
      values.push(taskId);
      db.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    }
    broker.broadcast("global", { type: "task_updated", id: taskId });
  }

  async function handleRunRequested(taskId) {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    if (!task) throw new Error(`task ${taskId} not found`);
    if (task.status !== "todo") {
      throw new Error(`task already ${task.status}`);
    }
    if (!task.executor_agent) throw new Error("no executor assigned");
    if (active.has(taskId)) throw new Error("task already running");

    const result = nextStatus(task.status, {
      type: "run_requested",
      executorAgent: task.executor_agent,
    });
    const errSe = result.sideEffects.find((se) => se.type === "error");
    if (errSe) throw new Error(errSe.message);

    applySideEffects(taskId, result.sideEffects, task.status, result.status);

    const runId = newRunId();
    const now = Date.now();
    db.prepare(
      "INSERT INTO task_runs (id, task_id, mode, agent_name, started_at, status) VALUES (?, ?, 'execute', ?, ?, 'running')",
    ).run(runId, taskId, task.executor_agent, now);

    const handle = spawn({
      binary: workerBinary,
      args: ["--task", taskId, "--mode", "execute", "--agent", task.executor_agent],
      env: {
        WORKLAB_RUN_ID: runId,
        WORKLAB_DATA_DIR: dataDir || "",
        WORKLAB_REPO_ROOT: repoRoot || "",
      },
      runId,
      taskId,
      broker,
      db,
      logger,
    });

    db.prepare("UPDATE task_runs SET worker_pid = ? WHERE id = ?").run(
      handle.pid || null,
      runId,
    );
    broker.broadcast("global", { type: "run_started", runId, taskId });

    active.set(taskId, { runId, handle });

    handle.done
      .then((res) => onWorkerExit(taskId, runId, res))
      .catch((err) => {
        logger?.error?.({ err, taskId, runId }, "worker promise rejected");
        onWorkerExit(taskId, runId, {
          exitCode: 1,
          status: "error",
          error: err.message,
        });
      });

    return { runId };
  }

  /**
   * Spawn a reviewer worker. Called from onWorkerExit when the state machine
   * emits a `spawn_reviewer` side effect after a successful execute run.
   */
  function spawnReviewer(taskId, reviewerAgent, priorRunId) {
    const runId = newRunId();
    const now = Date.now();
    db.prepare(
      "INSERT INTO task_runs (id, task_id, mode, agent_name, started_at, status) VALUES (?, ?, 'review', ?, ?, 'running')",
    ).run(runId, taskId, reviewerAgent, now);

    const handle = spawn({
      binary: workerBinary,
      args: ["--task", taskId, "--mode", "review", "--agent", reviewerAgent],
      env: {
        WORKLAB_RUN_ID: runId,
        WORKLAB_DATA_DIR: dataDir || "",
        WORKLAB_REPO_ROOT: repoRoot || "",
        WORKLAB_PRIOR_RUN_ID: priorRunId,
      },
      runId,
      taskId,
      broker,
      db,
      logger,
    });

    db.prepare("UPDATE task_runs SET worker_pid = ? WHERE id = ?").run(
      handle.pid || null,
      runId,
    );
    broker.broadcast("global", { type: "run_started", runId, taskId });

    // Execute run just ended (active entry was cleared in onWorkerExit). Install
    // the new reviewer entry in its place.
    active.set(taskId, { runId, handle });

    handle.done
      .then((res) => onWorkerExit(taskId, runId, res))
      .catch((err) => {
        logger?.error?.({ err, taskId, runId }, "reviewer promise rejected");
        onWorkerExit(taskId, runId, {
          exitCode: 1,
          status: "error",
          error: err.message,
        });
      });
  }

  function handleExecuteExit(taskId, runId, res, task) {
    if (res.status === "complete") {
      if (res.finalText) {
        db.prepare(
          `INSERT INTO task_comments (id, task_id, author_type, author_id, body, created_at) VALUES (?, ?, 'agent', ?, ?, ?)`,
        ).run(
          newCommentId(),
          taskId,
          task.executor_agent,
          res.finalText,
          Date.now(),
        );
      }
      const sm = nextStatus(task.status, {
        type: "run_completed",
        reviewerAgent: task.reviewer_agent,
      });
      applySideEffects(taskId, sm.sideEffects, task.status, sm.status);

      const spawnRev = sm.sideEffects.find((se) => se.type === "spawn_reviewer");
      if (spawnRev) {
        spawnReviewer(taskId, spawnRev.agentName, runId);
      }
    } else if (res.status === "cancelled") {
      db.prepare(
        `INSERT INTO task_comments (id, task_id, author_type, body, created_at) VALUES (?, ?, 'system', ?, ?)`,
      ).run(newCommentId(), taskId, "Run cancelled.", Date.now());
      broker.broadcast("global", { type: "task_updated", id: taskId });
    } else {
      const sm = nextStatus(task.status, {
        type: "run_failed",
        message: res.error || "run failed",
      });
      applySideEffects(taskId, sm.sideEffects, task.status, sm.status);
    }
  }

  function handleReviewExit(taskId, runId, res, task, reviewerAgent) {
    if (res.status === "complete") {
      // Parse verdict: first try a structured `verdict` event, else parse finalText.
      let verdict = null;
      let notes = "";
      const verdictEvent = Array.isArray(res.events)
        ? res.events.find((e) => e && e.type === "verdict")
        : null;
      if (verdictEvent && (verdictEvent.verdict === "APPROVE" || verdictEvent.verdict === "REJECT")) {
        verdict = verdictEvent.verdict;
        notes = verdictEvent.notes || "";
      } else {
        const parsed = parseVerdict(res.finalText);
        verdict = parsed.verdict;
        notes = parsed.notes;
      }

      // Always post the reviewer's final text as an agent comment (matches executor pattern).
      if (res.finalText) {
        db.prepare(
          `INSERT INTO task_comments (id, task_id, author_type, author_id, body, created_at) VALUES (?, ?, 'agent', ?, ?, ?)`,
        ).run(
          newCommentId(),
          taskId,
          reviewerAgent,
          res.finalText,
          Date.now(),
        );
      }

      if (verdict === "APPROVE") {
        const sm = nextStatus(task.status, { type: "review_approved" });
        applySideEffects(taskId, sm.sideEffects, task.status, sm.status);
        // Supplemental system verdict summary.
        db.prepare(
          `INSERT INTO task_comments (id, task_id, author_type, body, created_at) VALUES (?, ?, 'system', ?, ?)`,
        ).run(newCommentId(), taskId, "VERDICT: APPROVE", Date.now());
        broker.broadcast("global", { type: "task_updated", id: taskId });
      } else if (verdict === "REJECT") {
        const sm = nextStatus(task.status, { type: "review_rejected", notes });
        // The reducer emits post_review_comment with the rejection notes,
        // which applySideEffects turns into a system comment.
        applySideEffects(taskId, sm.sideEffects, task.status, sm.status);
      } else {
        // Parse failure — stay in_review, flag for the user.
        db.prepare(
          `INSERT INTO task_comments (id, task_id, author_type, body, created_at) VALUES (?, ?, 'system', ?, ?)`,
        ).run(
          newCommentId(),
          taskId,
          "Reviewer did not emit a VERDICT line — task remains in in_review",
          Date.now(),
        );
        broker.broadcast("global", { type: "task_updated", id: taskId });
      }
    } else if (res.status === "cancelled") {
      db.prepare(
        `INSERT INTO task_comments (id, task_id, author_type, body, created_at) VALUES (?, ?, 'system', ?, ?)`,
      ).run(newCommentId(), taskId, "Review cancelled.", Date.now());
      broker.broadcast("global", { type: "task_updated", id: taskId });
    } else {
      const msg = res.error || "unknown error";
      db.prepare(
        `INSERT INTO task_comments (id, task_id, author_type, body, created_at) VALUES (?, ?, 'system', ?, ?)`,
      ).run(newCommentId(), taskId, `Review failed: ${msg}`, Date.now());
      broker.broadcast("global", { type: "task_updated", id: taskId });
    }
  }

  function onWorkerExit(taskId, runId, res) {
    active.delete(taskId);
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    if (!task) return;

    const run = db.prepare("SELECT mode, agent_name FROM task_runs WHERE id = ?").get(runId);
    const mode = run?.mode || "execute";

    if (mode === "review") {
      handleReviewExit(taskId, runId, res, task, run.agent_name);
    } else {
      handleExecuteExit(taskId, runId, res, task);
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
