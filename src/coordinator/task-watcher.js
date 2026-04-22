import { nextStatus } from "../core/state-machine.js";
import { newRunId, newCommentId } from "../core/ids.js";

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

  function applySideEffects(taskId, sideEffects, currentStatus, newStatus) {
    const now = Date.now();
    const fields = [];
    const values = [];
    if (currentStatus !== newStatus) {
      fields.push("status = ?");
      values.push(newStatus);
    }
    for (const se of sideEffects) {
      if (se.type === "set_completed_at") {
        fields.push("completed_at = ?");
        values.push(now);
      }
      if (se.type === "clear_completed_at") {
        fields.push("completed_at = ?");
        values.push(null);
      }
      if (se.type === "clear_error_text") {
        fields.push("error_text = ?");
        values.push(null);
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

  function onWorkerExit(taskId, runId, res) {
    active.delete(taskId);
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    if (!task) return;

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
    } else if (res.status === "cancelled") {
      db.prepare(
        `INSERT INTO task_comments (id, task_id, author_type, body, created_at) VALUES (?, ?, 'system', ?, ?)`,
      ).run(newCommentId(), taskId, "Run cancelled.", Date.now());
      broker.broadcast("global", { type: "task_updated", id: taskId });
    } else {
      const errText = res.error || "run failed";
      db.prepare(
        `INSERT INTO task_comments (id, task_id, author_type, body, created_at) VALUES (?, ?, 'system', ?, ?)`,
      ).run(newCommentId(), taskId, `ERROR: ${errText}`, Date.now());
      db.prepare(
        "UPDATE tasks SET status = 'todo', error_text = ?, updated_at = ? WHERE id = ?",
      ).run(errText, Date.now(), taskId);
      broker.broadcast("global", { type: "task_updated", id: taskId });
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
