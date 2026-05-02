// R6 — plan-driven parent_review_policy.
//
// When a parent task delegates to a QA-style child agent (or the planner
// asks for `parent_review_policy: always_skip`), the parent's eventual
// execute-advance should bypass the redundant review pass and move
// straight to `done` with an AUTO-APPROVE verdict. When the delegation
// has no QA child and no policy override, the existing behaviour
// (advance → review) is preserved.

import { describe, it, expect, vi } from "vitest";
import { makeTestDb } from "../../helpers/test-db.js";
import { createTaskWatcher } from "../../../coordinator/task-watcher.js";
import { newTaskId } from "../../../core/ids.js";

function stubBroker() {
  return {
    subscribe: () => {},
    unsubscribe: () => {},
    size: () => 0,
    broadcast: () => {},
  };
}

function seedAgent(db, name) {
  const now = Date.now();
  db.prepare(
    "INSERT INTO agents (name, display_name, sdk, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(name, name, "claude", "claude:claude-sonnet-4-6", now, now);
}

function seedTask(db, { owner, reviewer = null, runPolicy = "manual", stage = "execute" } = {}) {
  const id = newTaskId();
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks
      (id, root_task_id, title, stage, owner_agent, reviewer_agent, run_policy, created_at, updated_at)
     VALUES (?, ?, 't', ?, ?, ?, ?, ?, ?)`,
  ).run(id, id, stage, owner, reviewer, runPolicy, now, now);
  return id;
}

function deferredSpawn() {
  const resolvers = [];
  const spawn = vi.fn(() => {
    let resolveDone;
    const done = new Promise((r) => { resolveDone = r; });
    resolvers.push(resolveDone);
    return { pid: 12345, done, cancel: vi.fn() };
  });
  return { spawn, resolvers };
}

const delegateToQaResult = {
  schema: "worklab.v2",
  stage: "execute",
  decision: "delegate",
  summary: "Delegated",
  details: "",
  artifacts: {},
  blocking_issues: [],
  pending_actions: [],
  subtasks: [
    {
      title: "Implement feature X",
      instructions: "Build the feature.",
      suggested_agent: "benchmark-coder",
    },
    {
      title: "QA the feature",
      instructions: "Inspect tests and screenshots.",
      suggested_agent: "benchmark-qa-reviewer",
    },
  ],
};

const delegateNoQaResult = {
  schema: "worklab.v2",
  stage: "execute",
  decision: "delegate",
  summary: "Delegated",
  details: "",
  artifacts: {},
  blocking_issues: [],
  pending_actions: [],
  subtasks: [
    {
      title: "Implement feature X",
      instructions: "Build the feature.",
      suggested_agent: "benchmark-coder",
    },
    {
      title: "Wire up the API endpoint",
      instructions: "Add the route handler.",
      suggested_agent: "benchmark-backend",
    },
  ],
};

function executeAdvanceResult() {
  return {
    schema: "worklab.v2",
    stage: "execute",
    decision: "advance",
    summary: "Implemented and verified",
    details: "",
    artifacts: {},
    blocking_issues: [],
    pending_actions: [],
    subtasks: [],
  };
}

describe("R6 parent_review_policy delegation flow", () => {
  it("auto-applies skip_when_qa_child when a delegation includes a QA child", async () => {
    const db = makeTestDb();
    seedAgent(db, "benchmark-planner");
    seedAgent(db, "benchmark-coder");
    seedAgent(db, "benchmark-qa-reviewer");
    seedAgent(db, "benchmark-product-lead");
    const taskId = seedTask(db, { owner: "benchmark-planner", reviewer: "benchmark-product-lead" });
    const { spawn, resolvers } = deferredSpawn();
    const watcher = createTaskWatcher({ db, broker: stubBroker(), spawn, workerBinary: "/fake" });

    await watcher.handleRunRequested(taskId);
    resolvers[0]({
      exitCode: 0,
      status: "complete",
      processStatus: "succeeded",
      finalText: "Delegated.",
      worklabResult: delegateToQaResult,
    });
    await new Promise((r) => setTimeout(r, 20));

    const parent = db.prepare("SELECT parent_review_policy, stage FROM tasks WHERE id = ?").get(taskId);
    expect(parent.parent_review_policy).toBe("skip_when_qa_child");
    expect(parent.stage).toBe("awaiting_children");
  });

  it("derives parent_review_policy=default when no QA child is delegated", async () => {
    const db = makeTestDb();
    seedAgent(db, "benchmark-planner");
    seedAgent(db, "benchmark-coder");
    seedAgent(db, "benchmark-backend");
    seedAgent(db, "benchmark-product-lead");
    const taskId = seedTask(db, { owner: "benchmark-planner", reviewer: "benchmark-product-lead" });
    const { spawn, resolvers } = deferredSpawn();
    const watcher = createTaskWatcher({ db, broker: stubBroker(), spawn, workerBinary: "/fake" });

    await watcher.handleRunRequested(taskId);
    resolvers[0]({
      exitCode: 0,
      status: "complete",
      processStatus: "succeeded",
      finalText: "Delegated.",
      worklabResult: delegateNoQaResult,
    });
    await new Promise((r) => setTimeout(r, 20));

    const parent = db.prepare("SELECT parent_review_policy, stage FROM tasks WHERE id = ?").get(taskId);
    expect(parent.parent_review_policy).toBe("default");
    expect(parent.stage).toBe("awaiting_children");
  });

  it("honours an explicit planner-requested parent_review_policy=always_skip", async () => {
    const db = makeTestDb();
    seedAgent(db, "benchmark-planner");
    seedAgent(db, "benchmark-coder");
    seedAgent(db, "benchmark-backend");
    seedAgent(db, "benchmark-product-lead");
    const taskId = seedTask(db, { owner: "benchmark-planner", reviewer: "benchmark-product-lead" });
    const { spawn, resolvers } = deferredSpawn();
    const watcher = createTaskWatcher({ db, broker: stubBroker(), spawn, workerBinary: "/fake" });

    await watcher.handleRunRequested(taskId);
    resolvers[0]({
      exitCode: 0,
      status: "complete",
      processStatus: "succeeded",
      finalText: "Delegated.",
      worklabResult: { ...delegateNoQaResult, parent_review_policy: "always_skip" },
    });
    await new Promise((r) => setTimeout(r, 20));

    const parent = db.prepare("SELECT parent_review_policy FROM tasks WHERE id = ?").get(taskId);
    expect(parent.parent_review_policy).toBe("always_skip");
  });

  it("ignores an unrecognised planner-requested policy and falls back to QA detection", async () => {
    const db = makeTestDb();
    seedAgent(db, "benchmark-planner");
    seedAgent(db, "benchmark-coder");
    seedAgent(db, "benchmark-qa-reviewer");
    seedAgent(db, "benchmark-product-lead");
    const taskId = seedTask(db, { owner: "benchmark-planner", reviewer: "benchmark-product-lead" });
    const { spawn, resolvers } = deferredSpawn();
    const watcher = createTaskWatcher({ db, broker: stubBroker(), spawn, workerBinary: "/fake" });

    await watcher.handleRunRequested(taskId);
    resolvers[0]({
      exitCode: 0,
      status: "complete",
      processStatus: "succeeded",
      finalText: "Delegated.",
      worklabResult: { ...delegateToQaResult, parent_review_policy: "ignore_me" },
    });
    await new Promise((r) => setTimeout(r, 20));

    const parent = db.prepare("SELECT parent_review_policy FROM tasks WHERE id = ?").get(taskId);
    expect(parent.parent_review_policy).toBe("skip_when_qa_child");
  });
});

describe("R6 parent_review_policy execute -> review boundary", () => {
  it("skips parent.review and auto-approves when a QA child exists and policy is skip_when_qa_child", async () => {
    const db = makeTestDb();
    seedAgent(db, "benchmark-coder");
    seedAgent(db, "benchmark-qa-reviewer");
    seedAgent(db, "benchmark-product-lead");
    // Parent task already configured to skip review when a QA child is
    // present. Pre-seed a delegated child whose owner agent matches the QA
    // pattern so the watcher's QA-child detection fires.
    const taskId = seedTask(db, {
      owner: "benchmark-coder",
      reviewer: "benchmark-product-lead",
    });
    db.prepare("UPDATE tasks SET parent_review_policy = 'skip_when_qa_child' WHERE id = ?").run(taskId);
    const childId = newTaskId();
    const now = Date.now();
    db.prepare(
      `INSERT INTO tasks
        (id, root_task_id, parent_task_id, title, stage, owner_agent, run_policy, created_at, updated_at)
       VALUES (?, ?, ?, 'qa', 'done', 'benchmark-qa-reviewer', 'manual', ?, ?)`,
    ).run(childId, childId, taskId, now, now);
    db.prepare(
      `INSERT INTO task_edges (parent_task_id, child_task_id, edge_type, required, created_at)
       VALUES (?, ?, 'subtask', 1, ?)`,
    ).run(taskId, childId, now);

    const { spawn, resolvers } = deferredSpawn();
    const watcher = createTaskWatcher({ db, broker: stubBroker(), spawn, workerBinary: "/fake" });

    await watcher.handleRunRequested(taskId);
    resolvers[0]({
      exitCode: 0,
      status: "complete",
      processStatus: "succeeded",
      finalText: "Wrapped up.",
      worklabResult: executeAdvanceResult(),
    });
    await new Promise((r) => setTimeout(r, 20));

    const after = db.prepare("SELECT stage, completed_at FROM tasks WHERE id = ?").get(taskId);
    expect(after.stage).toBe("done");
    expect(after.completed_at).toBeTruthy();
    // Only the executor was spawned — no parent.review run was ever
    // requested even though `reviewer_agent` is set.
    expect(spawn).toHaveBeenCalledTimes(1);

    const reviewRuns = db.prepare("SELECT id FROM task_runs WHERE task_id = ? AND mode = 'review'").all(taskId);
    expect(reviewRuns).toEqual([]);

    // Auto-approve verdict is recorded as a system comment.
    const comments = db.prepare("SELECT body FROM task_comments WHERE task_id = ?").all(taskId);
    const verdict = comments.find((row) => /AUTO-APPROVE/i.test(row.body));
    expect(verdict?.body).toContain("parent_review_policy");
  });

  it("does NOT skip parent.review when policy is default", async () => {
    const db = makeTestDb();
    seedAgent(db, "benchmark-coder");
    seedAgent(db, "benchmark-product-lead");
    const taskId = seedTask(db, {
      owner: "benchmark-coder",
      reviewer: "benchmark-product-lead",
    });
    // Default policy stays in place; no QA child seeded.
    const { spawn, resolvers } = deferredSpawn();
    const watcher = createTaskWatcher({ db, broker: stubBroker(), spawn, workerBinary: "/fake" });

    await watcher.handleRunRequested(taskId);
    resolvers[0]({
      exitCode: 0,
      status: "complete",
      processStatus: "succeeded",
      finalText: "Wrapped up.",
      worklabResult: executeAdvanceResult(),
    });
    await new Promise((r) => setTimeout(r, 20));

    const after = db.prepare("SELECT stage FROM tasks WHERE id = ?").get(taskId);
    expect(after.stage).toBe("review");
  });

  it("skips parent.review unconditionally when policy is always_skip", async () => {
    const db = makeTestDb();
    seedAgent(db, "benchmark-coder");
    seedAgent(db, "benchmark-product-lead");
    const taskId = seedTask(db, {
      owner: "benchmark-coder",
      reviewer: "benchmark-product-lead",
    });
    db.prepare("UPDATE tasks SET parent_review_policy = 'always_skip' WHERE id = ?").run(taskId);
    const { spawn, resolvers } = deferredSpawn();
    const watcher = createTaskWatcher({ db, broker: stubBroker(), spawn, workerBinary: "/fake" });

    await watcher.handleRunRequested(taskId);
    resolvers[0]({
      exitCode: 0,
      status: "complete",
      processStatus: "succeeded",
      finalText: "Wrapped up.",
      worklabResult: executeAdvanceResult(),
    });
    await new Promise((r) => setTimeout(r, 20));

    const after = db.prepare("SELECT stage FROM tasks WHERE id = ?").get(taskId);
    expect(after.stage).toBe("done");
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("does NOT skip parent.review when policy is skip_when_qa_child but no QA child exists", async () => {
    const db = makeTestDb();
    seedAgent(db, "benchmark-coder");
    seedAgent(db, "benchmark-product-lead");
    seedAgent(db, "benchmark-backend");
    const taskId = seedTask(db, {
      owner: "benchmark-coder",
      reviewer: "benchmark-product-lead",
    });
    db.prepare("UPDATE tasks SET parent_review_policy = 'skip_when_qa_child' WHERE id = ?").run(taskId);
    // Seed a non-QA child so the policy applies but should not trigger.
    const childId = newTaskId();
    const now = Date.now();
    db.prepare(
      `INSERT INTO tasks
        (id, root_task_id, parent_task_id, title, stage, owner_agent, run_policy, created_at, updated_at)
       VALUES (?, ?, ?, 'backend bit', 'done', 'benchmark-backend', 'manual', ?, ?)`,
    ).run(childId, childId, taskId, now, now);
    db.prepare(
      `INSERT INTO task_edges (parent_task_id, child_task_id, edge_type, required, created_at)
       VALUES (?, ?, 'subtask', 1, ?)`,
    ).run(taskId, childId, now);
    const { spawn, resolvers } = deferredSpawn();
    const watcher = createTaskWatcher({ db, broker: stubBroker(), spawn, workerBinary: "/fake" });

    await watcher.handleRunRequested(taskId);
    resolvers[0]({
      exitCode: 0,
      status: "complete",
      processStatus: "succeeded",
      finalText: "Wrapped up.",
      worklabResult: executeAdvanceResult(),
    });
    await new Promise((r) => setTimeout(r, 20));

    const after = db.prepare("SELECT stage FROM tasks WHERE id = ?").get(taskId);
    expect(after.stage).toBe("review");
  });
});
