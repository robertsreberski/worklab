// R6 — auto-approve QA-child meta-reviews when executor === reviewer.
//
// When the same agent is configured as both executor and reviewer (the QA
// child case where a single agent both runs and reviews its own pass) and
// the agent has `allow_self_review` enabled, the watcher should skip the
// LLM review call entirely and emit the approval as a direct state-machine
// transition. Without `allow_self_review`, the existing self-review
// enforcement still wins (the configuration is invalid).

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

function seedAgent(db, name, { allowSelfReview = true } = {}) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO agents (name, display_name, sdk, model, allow_self_review, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(name, name, "claude", "claude:claude-sonnet-4-6", allowSelfReview ? 1 : 0, now, now);
}

function seedTask(db, { owner, reviewer = null } = {}) {
  const id = newTaskId();
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks
      (id, root_task_id, title, stage, owner_agent, reviewer_agent, run_policy, created_at, updated_at)
     VALUES (?, ?, 't', 'execute', ?, ?, 'manual', ?, ?)`,
  ).run(id, id, owner, reviewer, now, now);
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

const advanceResult = {
  schema: "worklab.v2",
  stage: "execute",
  decision: "advance",
  summary: "Implemented and self-verified",
  details: "",
  artifacts: {},
  blocking_issues: [],
  pending_actions: [],
  subtasks: [],
};

describe("R6 QA meta-review auto-approve", () => {
  it("skips review and auto-approves when executor === reviewer with allow_self_review on", async () => {
    const db = makeTestDb();
    seedAgent(db, "benchmark-qa-reviewer", { allowSelfReview: true });
    const taskId = seedTask(db, {
      owner: "benchmark-qa-reviewer",
      reviewer: "benchmark-qa-reviewer",
    });
    const { spawn, resolvers } = deferredSpawn();
    const watcher = createTaskWatcher({ db, broker: stubBroker(), spawn, workerBinary: "/fake" });

    await watcher.handleRunRequested(taskId);
    expect(spawn).toHaveBeenCalledTimes(1);
    // The single spawn was the executor run; the review must be skipped.
    expect(spawn.mock.calls[0][0].args).toEqual(["--task", taskId, "--mode", "execute", "--agent", "benchmark-qa-reviewer"]);

    resolvers[0]({
      exitCode: 0,
      status: "complete",
      processStatus: "succeeded",
      finalText: "Done and self-checked.",
      worklabResult: advanceResult,
    });
    await new Promise((r) => setTimeout(r, 20));

    const after = db.prepare("SELECT stage, completed_at FROM tasks WHERE id = ?").get(taskId);
    expect(after.stage).toBe("done");
    expect(after.completed_at).toBeTruthy();
    // The review LLM call is skipped — only the original execute spawn.
    expect(spawn).toHaveBeenCalledTimes(1);

    const reviewRuns = db.prepare("SELECT id FROM task_runs WHERE task_id = ? AND mode = 'review'").all(taskId);
    expect(reviewRuns).toEqual([]);

    const verdict = db.prepare(
      "SELECT body FROM task_comments WHERE task_id = ? AND body LIKE 'VERDICT:%'",
    ).get(taskId);
    expect(verdict?.body).toContain("AUTO-APPROVE");
    expect(verdict?.body).toContain("executor_is_reviewer");
  });

  it("does NOT auto-approve when executor === reviewer but allow_self_review is off", async () => {
    const db = makeTestDb();
    seedAgent(db, "strict-coder", { allowSelfReview: false });
    const taskId = seedTask(db, { owner: "strict-coder", reviewer: "strict-coder" });
    const { spawn, resolvers } = deferredSpawn();
    const watcher = createTaskWatcher({ db, broker: stubBroker(), spawn, workerBinary: "/fake" });

    await watcher.handleRunRequested(taskId);
    resolvers[0]({
      exitCode: 0,
      status: "complete",
      processStatus: "succeeded",
      finalText: "Done.",
      worklabResult: advanceResult,
    });
    await new Promise((r) => setTimeout(r, 20));

    // The task transitions to review (the auto-approve path is gated on
    // allow_self_review). The subsequent self-review spawn would fail
    // with the existing self_review_disallowed enforcement.
    const after = db.prepare("SELECT stage FROM tasks WHERE id = ?").get(taskId);
    expect(after.stage).toBe("review");
    await expect(watcher.handleRunRequested(taskId)).rejects.toMatchObject({
      code: "self_review_disallowed",
    });
  });

  it("does NOT auto-approve when executor !== reviewer", async () => {
    const db = makeTestDb();
    seedAgent(db, "benchmark-coder");
    seedAgent(db, "benchmark-qa-reviewer");
    const taskId = seedTask(db, { owner: "benchmark-coder", reviewer: "benchmark-qa-reviewer" });
    const { spawn, resolvers } = deferredSpawn();
    const watcher = createTaskWatcher({ db, broker: stubBroker(), spawn, workerBinary: "/fake" });

    await watcher.handleRunRequested(taskId);
    resolvers[0]({
      exitCode: 0,
      status: "complete",
      processStatus: "succeeded",
      finalText: "Done.",
      worklabResult: advanceResult,
    });
    await new Promise((r) => setTimeout(r, 20));

    // Standard execute → review transition: a review run still has to be
    // spawned because the agent identities differ.
    const after = db.prepare("SELECT stage FROM tasks WHERE id = ?").get(taskId);
    expect(after.stage).toBe("review");
  });
});
