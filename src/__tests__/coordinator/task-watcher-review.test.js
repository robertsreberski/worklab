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

function seedTask(db, { owner = null, reviewer = null, stage = "execute", runPolicy = "manual" } = {}) {
  const id = newTaskId();
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks
      (id, root_task_id, title, stage, owner_agent, reviewer_agent, run_policy, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, id, "t", stage, owner, reviewer, runPolicy, now, now);
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
  it("owner failure stays retryable in execute and records failure context", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    const taskId = seedTask(db, { owner: "coder" });
    const { spawn, resolvers } = makeDeferredSpawn();
    const watcher = createTaskWatcher({ db, broker: stubBroker(), spawn, workerBinary: "/fake" });

    await watcher.handleRunRequested(taskId);
    resolvers[0]({ exitCode: 1, status: "error", processStatus: "failed", error: "boom" });
    await new Promise((r) => setTimeout(r, 20));

    const task = db.prepare("SELECT stage, error_text, stage_reason FROM tasks WHERE id = ?").get(taskId);
    expect(task).toMatchObject({ stage: "execute", error_text: "boom", stage_reason: "spawn" });
    const comment = db.prepare("SELECT body FROM task_comments WHERE task_id = ? AND author_type = 'system'").get(taskId);
    expect(comment.body).toBe("ERROR: boom");
  });

  it("owner advance with no reviewer goes straight to done with completed_at set", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    const taskId = seedTask(db, { owner: "coder" });
    const { spawn, resolvers } = makeDeferredSpawn();
    const watcher = createTaskWatcher({ db, broker: stubBroker(), spawn, workerBinary: "/fake" });

    await watcher.handleRunRequested(taskId);
    resolvers[0]({ exitCode: 0, status: "complete", processStatus: "succeeded", finalText: "done", worklabResult: advanceResult });
    await new Promise((r) => setTimeout(r, 20));

    const task = db.prepare("SELECT stage, completed_at FROM tasks WHERE id = ?").get(taskId);
    expect(task.stage).toBe("done");
    expect(task.completed_at).toBeTruthy();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("plan runs persist the latest editable task plan", async () => {
    const db = makeTestDb();
    seedAgent(db, "planner");
    const taskId = seedTask(db, { owner: "planner", stage: "plan" });
    const { spawn, resolvers } = makeDeferredSpawn();
    const watcher = createTaskWatcher({ db, broker: stubBroker(), spawn, workerBinary: "/fake" });

    await watcher.handleRunRequested(taskId);
    resolvers[0]({
      exitCode: 0,
      status: "complete",
      processStatus: "succeeded",
      finalText: "fallback text",
      worklabResult: synthesizeWorklabResult({
        stage: "plan",
        decision: "advance",
        summary: "ready",
        details: "## Plan\n\n1. Build it.",
      }),
    });
    await new Promise((r) => setTimeout(r, 20));

    const task = db.prepare("SELECT stage, plan_body, plan_updated_at, plan_updated_by, plan_source_run_id FROM tasks WHERE id = ?").get(taskId);
    const run = db.prepare("SELECT id FROM task_runs WHERE task_id = ?").get(taskId);
    expect(task.stage).toBe("execute");
    expect(task.plan_body).toBe("## Plan\n\n1. Build it.");
    expect(task.plan_updated_at).toBeTruthy();
    expect(task.plan_updated_by).toBe("planner");
    expect(task.plan_source_run_id).toBe(run.id);
  });

  it("owner advance with reviewer waits for explicit review run before approve reaches done", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    seedAgent(db, "checker");
    const taskId = seedTask(db, { owner: "coder", reviewer: "checker" });
    const { spawn, calls, resolvers } = makeDeferredSpawn();
    const watcher = createTaskWatcher({ db, broker: stubBroker(), spawn, workerBinary: "/fake", workspace: "/workspace" });
    const { runId: executeRunId } = await watcher.handleRunRequested(taskId);

    resolvers[0]({ exitCode: 0, status: "complete", processStatus: "succeeded", finalText: "owner output", worklabResult: advanceResult });
    await new Promise((r) => setTimeout(r, 20));

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT stage FROM tasks WHERE id = ?").get(taskId).stage).toBe("review");

    await watcher.handleRunRequested(taskId);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(calls[1].args).toEqual(expect.arrayContaining(["--mode", "review", "--agent", "checker"]));
    expect(calls[1].env.WORKLAB_PRIOR_RUN_ID).toBe(executeRunId);
    expect(calls[1].env.WORKLAB_WORKSPACE).toBe("/workspace");

    resolvers[1]({ exitCode: 0, status: "complete", processStatus: "succeeded", finalText: "approved", worklabResult: approveResult });
    await new Promise((r) => setTimeout(r, 20));

    const task = db.prepare("SELECT stage, completed_at FROM tasks WHERE id = ?").get(taskId);
    expect(task.stage).toBe("done");
    expect(task.completed_at).toBeTruthy();
  });

  it("review rejection routes back to execute and clears stale errors", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    seedAgent(db, "checker");
    const taskId = seedTask(db, { owner: "coder", reviewer: "checker" });
    db.prepare("UPDATE tasks SET error_text = 'stale' WHERE id = ?").run(taskId);
    const { spawn, resolvers } = makeDeferredSpawn();
    const watcher = createTaskWatcher({ db, broker: stubBroker(), spawn, workerBinary: "/fake" });
    await watcher.handleRunRequested(taskId);

    resolvers[0]({ exitCode: 0, status: "complete", processStatus: "succeeded", finalText: "owner output", worklabResult: advanceResult });
    await new Promise((r) => setTimeout(r, 20));
    await watcher.handleRunRequested(taskId);
    resolvers[1]({ exitCode: 0, status: "complete", processStatus: "succeeded", finalText: "rejected", worklabResult: rejectResult });
    await new Promise((r) => setTimeout(r, 20));

    const task = db.prepare("SELECT stage, error_text, stage_reason FROM tasks WHERE id = ?").get(taskId);
    expect(task).toMatchObject({ stage: "execute", error_text: null, stage_reason: "review requested changes" });
    const systemComment = db.prepare("SELECT body FROM task_comments WHERE task_id = ? AND author_type = 'system' AND body LIKE '%Missing tests%'").get(taskId);
    expect(systemComment).toBeTruthy();
  });

  it("missing review result is invalid_result and remains retryable in review", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    seedAgent(db, "checker");
    const taskId = seedTask(db, { owner: "coder", reviewer: "checker" });
    const { resolvers, spawn } = makeDeferredSpawn();
    const watcher = createTaskWatcher({ db, broker: stubBroker(), spawn, workerBinary: "/fake" });
    await watcher.handleRunRequested(taskId);

    resolvers[0]({ exitCode: 0, status: "complete", processStatus: "succeeded", finalText: "owner output", worklabResult: advanceResult });
    await new Promise((r) => setTimeout(r, 20));
    await watcher.handleRunRequested(taskId);
    resolvers[1]({ exitCode: 0, status: "complete", processStatus: "succeeded", finalText: "Looks good", events: [] });
    await new Promise((r) => setTimeout(r, 20));

    const task = db.prepare("SELECT stage, error_text FROM tasks WHERE id = ?").get(taskId);
    expect(task).toMatchObject({ stage: "review", error_text: "invalid worklab_result" });
    const run = db.prepare("SELECT failure_kind, retry_stage FROM task_runs WHERE mode = 'review'").get();
    expect(run).toMatchObject({ failure_kind: "invalid_result", retry_stage: "review" });
  });

  it("review cancellation stays in review without setting error_text and posts a system note", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    seedAgent(db, "checker");
    const taskId = seedTask(db, { owner: "coder", reviewer: "checker" });
    const { resolvers, spawn } = makeDeferredSpawn();
    const watcher = createTaskWatcher({ db, broker: stubBroker(), spawn, workerBinary: "/fake" });
    await watcher.handleRunRequested(taskId);

    resolvers[0]({ exitCode: 0, status: "complete", processStatus: "succeeded", finalText: "owner output", worklabResult: advanceResult });
    await new Promise((r) => setTimeout(r, 20));
    await watcher.handleRunRequested(taskId);
    resolvers[1]({ exitCode: 130, status: "cancelled", processStatus: "cancelled", error: "Run cancelled." });
    await new Promise((r) => setTimeout(r, 20));

    const task = db.prepare("SELECT stage, stage_reason, error_text, retry_count FROM tasks WHERE id = ?").get(taskId);
    // Cancel is user-initiated and must not be conflated with failure: no
    // error_text, no retry_count bump, distinct stage_reason. UI renders an
    // amber chip from the stage_reason rather than a red error chip.
    expect(task).toMatchObject({ stage: "review", stage_reason: "cancelled", error_text: null, retry_count: 0 });
    const cancelComment = db.prepare("SELECT body FROM task_comments WHERE task_id = ? AND body = 'Run cancelled.'").get(taskId);
    expect(cancelComment).toBeTruthy();
  });

  it("delegate result creates child tasks and parent waits", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    seedAgent(db, "helper");
    const taskId = seedTask(db, { owner: "coder" });
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

    const parent = db.prepare("SELECT stage, stage_reason FROM tasks WHERE id = ?").get(taskId);
    expect(parent).toMatchObject({ stage: "awaiting_children", stage_reason: "waiting for delegated subtasks" });
    const children = db.prepare("SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY subtask_order").all(taskId);
    expect(children).toHaveLength(2);
    expect(children[0]).toMatchObject({ title: "Required child", owner_agent: "helper", required: 1, stage: "execute" });
    expect(children[1]).toMatchObject({ title: "Optional child", required: 0 });
    const edges = db.prepare("SELECT required FROM task_edges WHERE parent_task_id = ? ORDER BY required DESC").all(taskId);
    expect(edges.map((edge) => edge.required)).toEqual([1, 0]);
    const comment = db.prepare("SELECT body FROM task_comments WHERE task_id = ? AND author_type = 'system' AND body LIKE 'Delegated %'").get(taskId);
    expect(comment.body).toContain("Required child");
    expect(comment.body).toContain("Optional child");
  });

  it("parent resumes after required child finishes while optional child failure remains a warning", async () => {
    const db = makeTestDb();
    seedAgent(db, "owner");
    seedAgent(db, "helper");
    const taskId = seedTask(db, { owner: "owner", runPolicy: "auto_plan_execute" });
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

    const parent = db.prepare("SELECT stage, stage_reason FROM tasks WHERE id = ?").get(taskId);
    expect(parent).toMatchObject({ stage: "execute", stage_reason: null });
    const optional = db.prepare("SELECT stage, error_text FROM tasks WHERE id = ?").get(children[1].id);
    expect(optional).toMatchObject({ stage: "execute", error_text: "optional failed" });
  });

  it("required child block propagates to the waiting parent", async () => {
    const db = makeTestDb();
    seedAgent(db, "owner");
    seedAgent(db, "helper");
    const taskId = seedTask(db, { owner: "owner", runPolicy: "auto_plan_execute" });
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

    const parent = db.prepare("SELECT stage, error_text, stage_reason FROM tasks WHERE id = ?").get(taskId);
    expect(parent).toMatchObject({
      stage: "blocked",
      error_text: "Required child blocked: Required child",
      stage_reason: "required_child_blocked",
    });
  });

  it("owner decision:block writes blocking_issues and parks the task at blocked", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    const taskId = seedTask(db, { owner: "coder" });
    const { spawn, resolvers } = makeDeferredSpawn();
    const watcher = createTaskWatcher({ db, broker: stubBroker(), spawn, workerBinary: "/fake" });

    await watcher.handleRunRequested(taskId);
    resolvers[0]({
      exitCode: 0,
      status: "complete",
      processStatus: "succeeded",
      finalText: "cannot proceed",
      worklabResult: {
        schema: "worklab.v2",
        stage: "execute",
        decision: "block",
        summary: "missing OPENAI_API_KEY",
        details: "",
        artifacts: {},
        blocking_issues: ["OPENAI_API_KEY env var is empty"],
        pending_actions: [],
        subtasks: [],
      },
    });
    await new Promise((r) => setTimeout(r, 20));

    const task = db.prepare("SELECT stage, stage_reason, blocking_issues_json, error_text FROM tasks WHERE id = ?").get(taskId);
    expect(task.stage).toBe("blocked");
    expect(task.stage_reason).toBe("missing OPENAI_API_KEY");
    expect(JSON.parse(task.blocking_issues_json)).toEqual(["OPENAI_API_KEY env var is empty"]);
    expect(task.error_text).toBe("missing OPENAI_API_KEY");
  });

  it("owner decision:pause writes pending_actions; human_move clears them on resume", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    const taskId = seedTask(db, { owner: "coder" });
    const { spawn, resolvers } = makeDeferredSpawn();
    const watcher = createTaskWatcher({ db, broker: stubBroker(), spawn, workerBinary: "/fake" });

    await watcher.handleRunRequested(taskId);
    resolvers[0]({
      exitCode: 0,
      status: "complete",
      processStatus: "succeeded",
      finalText: "needs you",
      worklabResult: {
        schema: "worklab.v2",
        stage: "execute",
        decision: "pause",
        summary: "approve the migration plan",
        details: "",
        artifacts: {},
        blocking_issues: [],
        pending_actions: ["Confirm migration step 3 is acceptable"],
        subtasks: [],
      },
    });
    await new Promise((r) => setTimeout(r, 20));

    const paused = db.prepare("SELECT stage, stage_reason, pending_actions_json FROM tasks WHERE id = ?").get(taskId);
    expect(paused.stage).toBe("awaiting_user");
    expect(paused.stage_reason).toBe("approve the migration plan");
    expect(JSON.parse(paused.pending_actions_json)).toEqual(["Confirm migration step 3 is acceptable"]);

    // Simulate the watcher's human_move handler clearing pending_actions on resume.
    const { nextStage } = await import("../../core/state-machine.js");
    const move = nextStage("awaiting_user", { type: "human_move", target: "execute" });
    expect(move.sideEffects).toContainEqual({ type: "clear_pending_actions" });
  });

  it("delegate with empty subtasks fails the run instead of orphaning the parent in awaiting_children", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    const taskId = seedTask(db, { owner: "coder" });
    const { spawn, resolvers } = makeDeferredSpawn();
    const watcher = createTaskWatcher({ db, broker: stubBroker(), spawn, workerBinary: "/fake" });

    await watcher.handleRunRequested(taskId);
    resolvers[0]({
      exitCode: 0,
      status: "complete",
      processStatus: "succeeded",
      finalText: "intended to delegate",
      worklabResult: {
        schema: "worklab.v2",
        stage: "execute",
        decision: "delegate",
        summary: "split work",
        details: "",
        artifacts: {},
        blocking_issues: [],
        pending_actions: [],
        subtasks: [],
      },
    });
    await new Promise((r) => setTimeout(r, 20));

    const task = db.prepare("SELECT stage, error_text FROM tasks WHERE id = ?").get(taskId);
    expect(task.stage).toBe("execute");
    expect(task.error_text).toMatch(/at least one subtask/);
    const edges = db.prepare("SELECT COUNT(*) AS c FROM task_edges WHERE parent_task_id = ?").get(taskId);
    expect(edges.c).toBe(0);
  });

  it("advance with pending_actions fails validation instead of treating them as a checklist", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    const taskId = seedTask(db, { owner: "coder" });
    const { spawn, resolvers } = makeDeferredSpawn();
    const watcher = createTaskWatcher({ db, broker: stubBroker(), spawn, workerBinary: "/fake" });

    await watcher.handleRunRequested(taskId);
    resolvers[0]({
      exitCode: 0,
      status: "complete",
      processStatus: "succeeded",
      finalText: "planned next steps",
      worklabResult: {
        schema: "worklab.v2",
        stage: "execute",
        decision: "advance",
        summary: "done",
        details: "",
        artifacts: {},
        blocking_issues: [],
        pending_actions: ["do follow-up work"],
        subtasks: [],
      },
    });
    await new Promise((r) => setTimeout(r, 20));

    const task = db.prepare("SELECT stage, error_text FROM tasks WHERE id = ?").get(taskId);
    expect(task.stage).toBe("execute");
    expect(task.error_text).toMatch(/pending_actions/);
    const edges = db.prepare("SELECT COUNT(*) AS c FROM task_edges WHERE parent_task_id = ?").get(taskId);
    expect(edges.c).toBe(0);
  });

  it("re-delegation supersedes the previous round's task_edges so prior children no longer hold the parent", async () => {
    const db = makeTestDb();
    seedAgent(db, "owner");
    seedAgent(db, "helper");
    const taskId = seedTask(db, { owner: "owner", runPolicy: "auto_plan_execute" });
    const { resolvers, spawn } = makeDeferredSpawn();
    const watcher = createTaskWatcher({ db, broker: stubBroker(), spawn, workerBinary: "/fake" });

    // Round 1: parent delegates one child, child finishes, parent resumes.
    await watcher.handleRunRequested(taskId);
    resolvers[0]({
      exitCode: 0,
      status: "complete",
      processStatus: "succeeded",
      finalText: "delegating r1",
      worklabResult: {
        schema: "worklab.v2",
        stage: "execute",
        decision: "delegate",
        summary: "round 1",
        details: "",
        artifacts: {},
        blocking_issues: [],
        pending_actions: [],
        subtasks: [{ title: "Round 1 child", instructions: "do it", suggested_agent: "helper", required: true }],
      },
    });
    await waitFor(() => spawn.mock.calls.length >= 2);
    resolvers[1]({
      exitCode: 0,
      status: "complete",
      processStatus: "succeeded",
      finalText: "r1 done",
      worklabResult: synthesizeWorklabResult({ stage: "execute", decision: "advance", summary: "r1 done" }),
    });
    await waitFor(() => {
      const t = db.prepare("SELECT stage FROM tasks WHERE id = ?").get(taskId);
      return t.stage === "execute";
    }, 2000);

    // Round 2: parent re-runs and delegates a second child.
    resolvers[2]({
      exitCode: 0,
      status: "complete",
      processStatus: "succeeded",
      finalText: "delegating r2",
      worklabResult: {
        schema: "worklab.v2",
        stage: "execute",
        decision: "delegate",
        summary: "round 2",
        details: "",
        artifacts: {},
        blocking_issues: [],
        pending_actions: [],
        subtasks: [{ title: "Round 2 child", instructions: "do it again", suggested_agent: "helper", required: true }],
      },
    });
    await new Promise((r) => setTimeout(r, 30));

    // Only the round-2 edge should remain — round-1's edge was superseded.
    const edges = db.prepare("SELECT child_task_id FROM task_edges WHERE parent_task_id = ? AND edge_type = 'subtask'").all(taskId);
    expect(edges).toHaveLength(1);
    const remainingChildTitle = db.prepare("SELECT title FROM tasks WHERE id = ?").get(edges[0].child_task_id).title;
    expect(remainingChildTitle).toBe("Round 2 child");

    // The original round-1 child is still in the DB (history preserved via parent_task_id),
    // it's just no longer in the active wait-set.
    const allChildren = db.prepare("SELECT title FROM tasks WHERE parent_task_id = ? ORDER BY created_at").all(taskId);
    expect(allChildren.map((row) => row.title)).toEqual(["Round 1 child", "Round 2 child"]);
  });

  it("explicit review run rejects when the reviewer agent is disabled and leaves the task at review", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    seedAgent(db, "checker");
    db.prepare("UPDATE agents SET enabled = 0 WHERE name = 'checker'").run();
    const taskId = seedTask(db, { owner: "coder", reviewer: "checker" });
    const { spawn, resolvers } = makeDeferredSpawn();
    const watcher = createTaskWatcher({ db, broker: stubBroker(), spawn, workerBinary: "/fake" });

    await watcher.handleRunRequested(taskId);
    resolvers[0]({ exitCode: 0, status: "complete", processStatus: "succeeded", finalText: "done", worklabResult: advanceResult });
    await new Promise((r) => setTimeout(r, 20));

    await expect(watcher.handleRunRequested(taskId)).rejects.toThrow(/agent disabled: checker/);
    const task = db.prepare("SELECT stage, error_text, stage_reason FROM tasks WHERE id = ?").get(taskId);
    expect(task.stage).toBe("review");
    expect(task.error_text).toBeNull();
    expect(task.stage_reason).toBeNull();
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
