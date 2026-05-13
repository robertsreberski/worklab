import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnTaskRun } from "../../coordinator/watcher/spawn-run.js";
import { makeTestDb } from "../helpers/test-db.js";
import { newRunId, newTaskId } from "../../core/ids.js";

function stubBroker() {
  return {
    broadcasts: [],
    subscribe: () => {},
    unsubscribe: () => {},
    broadcast: (ch, p) => {
      this?.broadcasts?.push?.({ ch, p });
    },
    size: () => 0,
  };
}

function stubSpawn() {
  return ({ runId }) => ({
    pid: 0,
    done: Promise.resolve({ runId, exitCode: 0, status: "complete", processStatus: "succeeded" }),
  });
}

function seedTaskAndAgent(db) {
  const taskId = newTaskId();
  const now = Date.now();
  db.prepare("INSERT INTO tasks (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(taskId, "todo-inherit-demo", now, now);
  db.prepare("INSERT INTO agents (name, display_name, sdk, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("coder", "Coder", "claude", "claude:claude-sonnet-4-6", now, now);
  return { taskId, now };
}

function seedParentRun(db, taskId, todoState) {
  const parentRunId = newRunId();
  const now = Date.now();
  db.prepare(`INSERT INTO task_runs
      (id, task_id, mode, stage, agent_name, started_at, status, process_status, todo_state_json)
    VALUES (?, ?, 'execute', 'execute', 'coder', ?, 'error', 'failed', ?)
  `).run(parentRunId, taskId, now, JSON.stringify(todoState));
  return parentRunId;
}

const populatedState = {
  todos: [
    { content: "Inspect repo", status: "completed" },
    { content: "Wire MCP tool", status: "in_progress", active_form: "Wiring handlers" },
    { content: "Add tests", status: "pending" },
  ],
  updated_at: 1700000000,
  update_count: 7,
};

describe("spawn-run todo inheritance (P2)", () => {
  it("seeds the new run's todo_state_json from the parent on recovery_continuation", async () => {
    const db = makeTestDb();
    const dataDir = mkdtempSync(join(tmpdir(), "worklab-todo-inherit-"));
    try {
      const broker = stubBroker();
      const { taskId } = seedTaskAndAgent(db);
      const parentRunId = seedParentRun(db, taskId, populatedState);

      const task = db.prepare("SELECT id, title, stage FROM tasks WHERE id = ?").get(taskId);
      const { runId } = spawnTaskRun({
        db,
        broker,
        spawn: stubSpawn(),
        workerBinary: "/bin/true",
        logger: { warn: () => {}, error: () => {}, info: () => {} },
        repoRoot: dataDir,
        dataDir,
        workspace: dataDir,
        runTimeoutMs: 60_000,
        runIdleWarningMs: 0,
        logInlineLimit: 0,
        active: new Map(),
        activeByRunId: new Map(),
        onWorkerExit: () => {},
        task,
        stage: "execute",
        mode: "execute",
        agentName: "coder",
        parentRunId,
        diagnosticsSeed: { continuation_of_run_id: parentRunId, continuation_reason: "provider_retryable" },
      });

      const child = db.prepare("SELECT parent_relationship, todo_state_json FROM task_runs WHERE id = ?").get(runId);
      expect(child.parent_relationship).toBe("recovery_continuation");
      const childTodo = JSON.parse(child.todo_state_json);
      expect(childTodo.todos).toEqual(populatedState.todos);
      expect(childTodo.updated_at).toBe(populatedState.updated_at);
      expect(childTodo.update_count).toBe(0);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("passes a recovery transport override to the worker environment", async () => {
    const db = makeTestDb();
    const dataDir = mkdtempSync(join(tmpdir(), "worklab-transport-override-"));
    try {
      const broker = stubBroker();
      const { taskId } = seedTaskAndAgent(db);
      const parentRunId = seedParentRun(db, taskId, populatedState);
      const task = db.prepare("SELECT id, title, stage FROM tasks WHERE id = ?").get(taskId);
      let spawnArgs = null;

      spawnTaskRun({
        db,
        broker,
        spawn: (args) => {
          spawnArgs = args;
          return stubSpawn()(args);
        },
        workerBinary: "/bin/true",
        logger: { warn: () => {}, error: () => {}, info: () => {} },
        repoRoot: dataDir,
        dataDir,
        workspace: dataDir,
        runTimeoutMs: 60_000,
        runIdleWarningMs: 0,
        logInlineLimit: 0,
        active: new Map(),
        activeByRunId: new Map(),
        onWorkerExit: () => {},
        task,
        stage: "execute",
        mode: "execute",
        agentName: "coder",
        parentRunId,
        diagnosticsSeed: {
          continuation_of_run_id: parentRunId,
          continuation_reason: "provider_retryable",
          pi_transport_override: "sse",
        },
      });

      expect(spawnArgs.env.WORKLAB_PI_CODEX_TRANSPORT).toBe("sse");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("leaves the empty default for stage_progression and manual_retry", async () => {
    const db = makeTestDb();
    const dataDir = mkdtempSync(join(tmpdir(), "worklab-todo-inherit-"));
    try {
      const broker = stubBroker();
      const { taskId } = seedTaskAndAgent(db);
      const parentRunId = seedParentRun(db, taskId, populatedState);
      const task = db.prepare("SELECT id, title, stage FROM tasks WHERE id = ?").get(taskId);

      // stage_progression: parentRunId without continuation_of_run_id
      const stageProgression = spawnTaskRun({
        db,
        broker,
        spawn: stubSpawn(),
        workerBinary: "/bin/true",
        logger: { warn: () => {}, error: () => {}, info: () => {} },
        repoRoot: dataDir,
        dataDir,
        workspace: dataDir,
        runTimeoutMs: 60_000,
        runIdleWarningMs: 0,
        logInlineLimit: 0,
        active: new Map(),
        activeByRunId: new Map(),
        onWorkerExit: () => {},
        task,
        stage: "review",
        mode: "review",
        agentName: "coder",
        parentRunId,
      });

      const stageRow = db.prepare("SELECT parent_relationship, todo_state_json FROM task_runs WHERE id = ?")
        .get(stageProgression.runId);
      expect(stageRow.parent_relationship).toBe("stage_progression");
      expect(JSON.parse(stageRow.todo_state_json)).toEqual({ todos: [], updated_at: null, update_count: 0 });

      // manual_retry: diagnosticsSeed.manual_retry = true
      const manualRetry = spawnTaskRun({
        db,
        broker,
        spawn: stubSpawn(),
        workerBinary: "/bin/true",
        logger: { warn: () => {}, error: () => {}, info: () => {} },
        repoRoot: dataDir,
        dataDir,
        workspace: dataDir,
        runTimeoutMs: 60_000,
        runIdleWarningMs: 0,
        logInlineLimit: 0,
        active: new Map(),
        activeByRunId: new Map(),
        onWorkerExit: () => {},
        task,
        stage: "execute",
        mode: "execute",
        agentName: "coder",
        parentRunId: null,
        diagnosticsSeed: { manual_retry: true },
      });

      const manualRow = db.prepare("SELECT parent_relationship, todo_state_json FROM task_runs WHERE id = ?")
        .get(manualRetry.runId);
      expect(manualRow.parent_relationship).toBe("manual_retry");
      expect(JSON.parse(manualRow.todo_state_json)).toEqual({ todos: [], updated_at: null, update_count: 0 });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("inheritRunTodoState returns null for an empty parent state so the column default stands", async () => {
    const { inheritRunTodoState } = await import("../../core/run-todos.js");
    expect(inheritRunTodoState(null)).toBe(null);
    expect(inheritRunTodoState({ todos: [], updated_at: null, update_count: 0 })).toBe(null);
    expect(inheritRunTodoState(JSON.stringify({ todos: [], updated_at: null, update_count: 5 }))).toBe(null);
  });
});
