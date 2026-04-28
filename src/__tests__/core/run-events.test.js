import { describe, expect, it } from "vitest";
import { makeTestDb } from "../helpers/test-db.js";
import { buildRunLifecycleEvent } from "../../core/run-events.js";

function seedAgent(db, name = "coder") {
  const now = Date.now();
  db.prepare(
    "INSERT INTO agents (name, display_name, sdk, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(name, name, "claude", "claude:claude-sonnet-4-6", now, now);
}

describe("run lifecycle events", () => {
  it("builds task run metadata from the database", () => {
    const db = makeTestDb();
    seedAgent(db);
    const now = Date.now();
    db.prepare(`
      INSERT INTO tasks (id, task_key, root_task_id, title, stage, owner_agent, created_at, updated_at)
      VALUES ('task-1', 'T-7', 'task-1', 'Implement notifications', 'execute', 'coder', ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO task_runs
        (id, task_id, mode, stage, agent_name, status, process_status, failure_kind, error_text, started_at, ended_at)
      VALUES ('run-1', 'task-1', 'execute', 'execute', 'coder', 'error', 'failed', 'spawn', 'worker exited', ?, ?)
    `).run(now - 1000, now);

    expect(buildRunLifecycleEvent(db, "run_ended", "run-1")).toEqual({
      type: "run_ended",
      runId: "run-1",
      taskId: "task-1",
      taskKey: "T-7",
      taskTitle: "Implement notifications",
      mode: "execute",
      stage: "execute",
      agentName: "coder",
      status: "error",
      processStatus: "failed",
      failureKind: "spawn",
      errorText: "worker exited",
    });
  });

  it("normalizes legacy completed rows whose process status is stale", () => {
    const db = makeTestDb();
    seedAgent(db);
    const now = Date.now();
    db.prepare(`
      INSERT INTO tasks (id, root_task_id, title, stage, owner_agent, created_at, updated_at)
      VALUES ('task-1', 'task-1', 'Done task', 'done', 'coder', ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO task_runs (id, task_id, mode, stage, agent_name, status, process_status, started_at)
      VALUES ('run-1', 'task-1', 'execute', 'execute', 'coder', 'complete', 'running', ?)
    `).run(now);

    expect(buildRunLifecycleEvent(db, "run_ended", "run-1").processStatus).toBe("succeeded");
  });
});
