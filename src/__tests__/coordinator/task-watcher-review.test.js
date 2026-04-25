import { describe, it, expect, vi } from "vitest";
import { makeTestDb } from "../helpers/test-db.js";
import { createTaskWatcher } from "../../coordinator/task-watcher.js";
import { newTaskId } from "../../core/ids.js";
import { synthesizeWorklabResult } from "../../core/worklab-result.js";

function stubBroker() {
  const broadcasts = [];
  return {
    broadcasts,
    subscribe: () => {},
    unsubscribe: () => {},
    broadcast: (c, p) => broadcasts.push({ c, p }),
    size: () => 0,
  };
}

function seedAgent(db, name) {
  const now = Date.now();
  db.prepare(
    "INSERT INTO agents (name, display_name, sdk, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(name, name, "claude", "claude:claude-sonnet-4-6", now, now);
}

function seedTask(db, { executor = null, reviewer = null, stage = "execute" } = {}) {
  const id = newTaskId();
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks
      (id, root_task_id, title, status, stage, owner_agent, executor_agent, reviewer_agent, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, id, "t", stage === "review" ? "in_review" : "todo", stage, executor, executor, reviewer, now, now);
  return id;
}

function makeDeferredSpawn() {
  const resolvers = [];
  const calls = [];
  const spawn = vi.fn((opts) => {
    calls.push(opts);
    let resolve;
    const done = new Promise((r) => { resolve = r; });
    resolvers.push(resolve);
    return { pid: 1000 + resolvers.length, done, cancel: vi.fn() };
  });
  return { spawn, calls, resolvers };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out waiting for condition");
}

const advanceResult = synthesizeWorklabResult({ stage: "execute", decision: "advance", summary: "implemented" });
const approveResult = synthesizeWorklabResult({ stage: "review", decision: "approve", summary: "approved" });
const rejectResult = synthesizeWorklabResult({ stage: "review", decision: "reject", summary: "changes requested", details: "Missing tests." });

describe("task-watcher v2 workflow", () => {
  it("executor failure stays retryable in execute and records failure context", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    const taskId = seedTask(db, { executor: "coder" });
    const { spawn, resolvers } = makeDeferredSpawn();
    const watcher = createTaskWatcher({ db, broker: stubBroker(), spawn, workerBinary: "/fake" });

    await watcher.handleRunRequested(taskId);
    resolvers[0]({ exitCode: 1, status: "error", processStatus: "failed", error: "boom" });
    await new Promise((r) => setTimeout(r, 20));

    const task = db.prepare("SELECT stage, status, error_text, stage_reason FROM tasks WHERE id = ?").get(taskId);
    expect(task).toMatchObject({ stage: "execute", status: "todo", error_text: "boom", stage_reason: "spawn" });
    const comment = db.prepare("SELECT body FROM task_comments WHERE task_id = ? AND author_type = 'system'").get(taskId);
    expect(comment.body).toBe("ERROR: boom");
  });

  it("executor advance with no reviewer parks in review for human approval", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    const taskId = seedTask(db, { executor: "coder" });
    const { spawn, resolvers } = makeDeferredSpawn();
    const watcher = createTaskWatcher({ db, broker: stubBroker(), spawn, workerBinary: "/fake" });

    await watcher.handleRunRequested(taskId);
    resolvers[0]({ exitCode: 0, status: "complete", processStatus: "succeeded", finalText: "done", worklabResult: advanceResult });
    await new Promise((r) => setTimeout(r, 20));

    const task = db.prepare("SELECT stage, status FROM tasks WHERE id = ?").get(taskId);
    expect(task).toMatchObject({ stage: "review", status: "in_review" });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("executor advance with reviewer spawns review and approve reaches done", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    seedAgent(db, "checker");
    const taskId = seedTask(db, { executor: "coder", reviewer: "checker" });
    const { spawn, calls, resolvers } = makeDeferredSpawn();
    const watcher = createTaskWatcher({ db, broker: stubBroker(), spawn, workerBinary: "/fake", workspace: "/workspace" });
    const { runId: executeRunId } = await watcher.handleRunRequested(taskId);

    resolvers[0]({ exitCode: 0, status: "complete", processStatus: "succeeded", finalText: "executor output", worklabResult: advanceResult });
    await new Promise((r) => setTimeout(r, 20));

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(calls[1].args).toEqual(expect.arrayContaining(["--mode", "review", "--agent", "checker"]));
    expect(calls[1].env.WORKLAB_PRIOR_RUN_ID).toBe(executeRunId);
    expect(calls[1].env.WORKLAB_WORKSPACE).toBe("/workspace");

    resolvers[1]({ exitCode: 0, status: "complete", processStatus: "succeeded", finalText: "approved", worklabResult: approveResult });
    await new Promise((r) => setTimeout(r, 20));

    const task = db.prepare("SELECT stage, status, completed_at FROM tasks WHERE id = ?").get(taskId);
    expect(task.stage).toBe("done");
    expect(task.status).toBe("done");
    expect(task.completed_at).toBeTruthy();
  });

  it("review rejection routes back to execute and clears stale errors", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    seedAgent(db, "checker");
    const taskId = seedTask(db, { executor: "coder", reviewer: "checker" });
    db.prepare("UPDATE tasks SET error_text = 'stale' WHERE id = ?").run(taskId);
    const { spawn, resolvers } = makeDeferredSpawn();
    const watcher = createTaskWatcher({ db, broker: stubBroker(), spawn, workerBinary: "/fake" });
    await watcher.handleRunRequested(taskId);

    resolvers[0]({ exitCode: 0, status: "complete", processStatus: "succeeded", finalText: "executor output", worklabResult: advanceResult });
    await new Promise((r) => setTimeout(r, 20));
    resolvers[1]({ exitCode: 0, status: "complete", processStatus: "succeeded", finalText: "rejected", worklabResult: rejectResult });
    await new Promise((r) => setTimeout(r, 20));

    const task = db.prepare("SELECT stage, status, error_text, stage_reason FROM tasks WHERE id = ?").get(taskId);
    expect(task).toMatchObject({ stage: "execute", status: "todo", error_text: null, stage_reason: "review requested changes" });
    const systemComment = db.prepare("SELECT body FROM task_comments WHERE task_id = ? AND author_type = 'system' AND body LIKE '%Missing tests%'").get(taskId);
    expect(systemComment).toBeTruthy();
  });

  it("missing review result is invalid_result and remains retryable in review", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    seedAgent(db, "checker");
    const taskId = seedTask(db, { executor: "coder", reviewer: "checker" });
    const { resolvers, spawn } = makeDeferredSpawn();
    const watcher = createTaskWatcher({ db, broker: stubBroker(), spawn, workerBinary: "/fake" });
    await watcher.handleRunRequested(taskId);

    resolvers[0]({ exitCode: 0, status: "complete", processStatus: "succeeded", finalText: "executor output", worklabResult: advanceResult });
    await new Promise((r) => setTimeout(r, 20));
    resolvers[1]({ exitCode: 0, status: "complete", processStatus: "succeeded", finalText: "Looks good", events: [] });
    await new Promise((r) => setTimeout(r, 20));

    const task = db.prepare("SELECT stage, status, error_text FROM tasks WHERE id = ?").get(taskId);
    expect(task).toMatchObject({ stage: "review", status: "in_review", error_text: "invalid worklab_result" });
    const run = db.prepare("SELECT failure_kind, retry_stage FROM task_runs WHERE mode = 'review'").get();
    expect(run).toMatchObject({ failure_kind: "invalid_result", retry_stage: "review" });
  });

  it("review cancellation stays in review with a retryable cancellation reason", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    seedAgent(db, "checker");
    const taskId = seedTask(db, { executor: "coder", reviewer: "checker" });
    const { resolvers, spawn } = makeDeferredSpawn();
    const watcher = createTaskWatcher({ db, broker: stubBroker(), spawn, workerBinary: "/fake" });
    await watcher.handleRunRequested(taskId);

    resolvers[0]({ exitCode: 0, status: "complete", processStatus: "succeeded", finalText: "executor output", worklabResult: advanceResult });
    await new Promise((r) => setTimeout(r, 20));
    resolvers[1]({ exitCode: 130, status: "cancelled", processStatus: "cancelled", error: "Run cancelled." });
    await new Promise((r) => setTimeout(r, 20));

    const task = db.prepare("SELECT stage, status, stage_reason, error_text FROM tasks WHERE id = ?").get(taskId);
    expect(task).toMatchObject({ stage: "review", status: "in_review", stage_reason: "cancelled", error_text: "Run cancelled." });
  });

  it("delegate result creates child tasks and parent waits", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    seedAgent(db, "helper");
    const taskId = seedTask(db, { executor: "coder" });
    const { resolvers, spawn } = makeDeferredSpawn();
    const watcher = createTaskWatcher({ db, broker: stubBroker(), spawn, workerBinary: "/fake" });
    const delegateResult = {
      schema: "worklab.v2",
      stage: "execute",
      decision: "delegate",
      summary: "split work",
      details: "",
      artifacts: {},
      blocking_issues: [],
      pending_actions: [],
      subtasks: [
        { title: "Required child", instructions: "do required", suggested_agent: "helper", required: true },
        { title: "Optional child", instructions: "do optional", suggested_agent: "helper", required: false },
      ],
    };

    await watcher.handleRunRequested(taskId);
    resolvers[0]({ exitCode: 0, status: "complete", processStatus: "succeeded", finalText: "delegating", worklabResult: delegateResult });
    await new Promise((r) => setTimeout(r, 30));

    const parent = db.prepare("SELECT stage, status, stage_reason FROM tasks WHERE id = ?").get(taskId);
    expect(parent).toMatchObject({ stage: "awaiting_children", status: "blocked", stage_reason: "waiting for delegated subtasks" });
    const children = db.prepare("SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY subtask_order").all(taskId);
    expect(children).toHaveLength(2);
    expect(children[0]).toMatchObject({ title: "Required child", owner_agent: "helper", required: 1, stage: "execute" });
    expect(children[1]).toMatchObject({ title: "Optional child", required: 0 });
    const edges = db.prepare("SELECT required FROM task_edges WHERE parent_task_id = ? ORDER BY required DESC").all(taskId);
    expect(edges.map((edge) => edge.required)).toEqual([1, 0]);
  });

  it("parent resumes after required child finishes while optional child failure remains a warning", async () => {
    const db = makeTestDb();
    seedAgent(db, "owner");
    seedAgent(db, "helper");
    const taskId = seedTask(db, { executor: "owner" });
    const { resolvers, spawn } = makeDeferredSpawn();
    const watcher = createTaskWatcher({ db, broker: stubBroker(), spawn, workerBinary: "/fake" });
    const delegateResult = {
      schema: "worklab.v2",
      stage: "execute",
      decision: "delegate",
      summary: "split work",
      details: "",
      artifacts: {},
      blocking_issues: [],
      pending_actions: [],
      subtasks: [
        { title: "Required child", instructions: "required", suggested_agent: "helper", required: true },
        { title: "Optional child", instructions: "optional", suggested_agent: "helper", required: false },
      ],
    };

    await watcher.handleRunRequested(taskId);
    resolvers[0]({ exitCode: 0, status: "complete", processStatus: "succeeded", finalText: "delegating", worklabResult: delegateResult });
    await waitFor(() => spawn.mock.calls.length >= 3);

    const children = db.prepare("SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY subtask_order").all(taskId);
    expect(children).toHaveLength(2);
    // Optional child fails first; parent must keep waiting on the required child.
    resolvers[2]({ exitCode: 1, status: "error", processStatus: "failed", error: "optional failed" });
    await new Promise((r) => setTimeout(r, 20));
    expect(db.prepare("SELECT stage FROM tasks WHERE id = ?").get(taskId).stage).toBe("awaiting_children");

    resolvers[1]({
      exitCode: 0,
      status: "complete",
      processStatus: "succeeded",
      finalText: "required done",
      worklabResult: synthesizeWorklabResult({ stage: "execute", decision: "advance", summary: "required done" }),
    });
    await waitFor(() => spawn.mock.calls.length >= 4);

    const parent = db.prepare("SELECT stage, status, stage_reason FROM tasks WHERE id = ?").get(taskId);
    expect(parent).toMatchObject({ stage: "execute", status: "in_progress", stage_reason: null });
    const optional = db.prepare("SELECT stage, error_text FROM tasks WHERE id = ?").get(children[1].id);
    expect(optional).toMatchObject({ stage: "execute", error_text: "optional failed" });
  });

  it("required child block propagates to the waiting parent", async () => {
    const db = makeTestDb();
    seedAgent(db, "owner");
    seedAgent(db, "helper");
    const taskId = seedTask(db, { executor: "owner" });
    const { resolvers, spawn } = makeDeferredSpawn();
    const watcher = createTaskWatcher({ db, broker: stubBroker(), spawn, workerBinary: "/fake" });
    await watcher.handleRunRequested(taskId);
    resolvers[0]({
      exitCode: 0,
      status: "complete",
      processStatus: "succeeded",
      finalText: "delegating",
      worklabResult: {
        schema: "worklab.v2",
        stage: "execute",
        decision: "delegate",
        summary: "split",
        details: "",
        artifacts: {},
        blocking_issues: [],
        pending_actions: [],
        subtasks: [{ title: "Required child", instructions: "required", suggested_agent: "helper", required: true }],
      },
    });
    await waitFor(() => spawn.mock.calls.length >= 2);

    resolvers[1]({
      exitCode: 0,
      status: "complete",
      processStatus: "succeeded",
      finalText: "blocked",
      worklabResult: {
        schema: "worklab.v2",
        stage: "execute",
        decision: "block",
        summary: "missing secret",
        details: "",
        artifacts: {},
        blocking_issues: ["SECRET"],
        pending_actions: [],
        subtasks: [],
      },
    });
    await new Promise((r) => setTimeout(r, 30));

    const parent = db.prepare("SELECT stage, status, error_text, stage_reason FROM tasks WHERE id = ?").get(taskId);
    expect(parent).toMatchObject({
      stage: "blocked",
      status: "blocked",
      error_text: "Required child blocked: Required child",
      stage_reason: "required_child_blocked",
    });
  });
});
