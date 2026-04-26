import { describe, it, expect } from "vitest";
import { makeTestDb } from "../helpers/test-db.js";
import { applyTaskSideEffects, taskStage } from "../../core/task-side-effects.js";
import { newTaskId } from "../../core/ids.js";

function seedTask(db, overrides = {}) {
  const id = newTaskId();
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks (id, root_task_id, title, stage, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, id, overrides.title || "t", overrides.stage || "plan", now, now);
  return id;
}

function seedRun(db, taskId, runId) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO task_runs (id, task_id, mode, stage, agent_name, started_at, status, process_status, retry_stage)
     VALUES (?, ?, 'execute', 'execute', 'tester', ?, 'running', 'running', 'execute')`,
  ).run(runId, taskId, now);
  return runId;
}

function readTask(db, id) {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
}

describe("taskStage", () => {
  it("returns stage when present", () => {
    expect(taskStage({ stage: "execute" })).toBe("execute");
  });
  it("falls back to plan when missing or null", () => {
    expect(taskStage({})).toBe("plan");
    expect(taskStage(null)).toBe("plan");
    expect(taskStage(undefined)).toBe("plan");
  });
});

describe("applyTaskSideEffects", () => {
  it("writes the stage transition when current and new differ", () => {
    const db = makeTestDb();
    const id = seedTask(db, { stage: "plan" });
    applyTaskSideEffects(db, id, [], "plan", "execute");
    expect(readTask(db, id).stage).toBe("execute");
  });

  it("does not change stage when transition is a no-op", () => {
    const db = makeTestDb();
    const id = seedTask(db, { stage: "plan" });
    applyTaskSideEffects(db, id, [], "plan", "plan");
    expect(readTask(db, id).stage).toBe("plan");
  });

  it("dispatches set_completed_at and clear_completed_at", () => {
    const db = makeTestDb();
    const id = seedTask(db);
    applyTaskSideEffects(db, id, [{ type: "set_completed_at" }], "plan", "done", { now: 12345 });
    expect(readTask(db, id).completed_at).toBe(12345);
    applyTaskSideEffects(db, id, [{ type: "clear_completed_at" }], "done", "execute");
    expect(readTask(db, id).completed_at).toBeNull();
  });

  it("dispatches error_text + stage_reason set/clear pairs", () => {
    const db = makeTestDb();
    const id = seedTask(db);
    applyTaskSideEffects(db, id, [
      { type: "set_error_text", message: "boom" },
      { type: "set_stage_reason", reason: "because" },
    ], "plan", "blocked");
    let row = readTask(db, id);
    expect(row.error_text).toBe("boom");
    expect(row.stage_reason).toBe("because");

    applyTaskSideEffects(db, id, [
      { type: "clear_error_text" },
      { type: "clear_stage_reason" },
    ], "blocked", "execute");
    row = readTask(db, id);
    expect(row.error_text).toBeNull();
    expect(row.stage_reason).toBeNull();
  });

  it("serializes pending_actions and blocking_issues as JSON", () => {
    const db = makeTestDb();
    const id = seedTask(db);
    applyTaskSideEffects(db, id, [
      { type: "set_pending_actions", pendingActions: ["paste log", "confirm"] },
      { type: "set_blocking_issues", blockingIssues: ["needs creds"] },
    ], "plan", "awaiting_user");
    let row = readTask(db, id);
    expect(JSON.parse(row.pending_actions_json)).toEqual(["paste log", "confirm"]);
    expect(JSON.parse(row.blocking_issues_json)).toEqual(["needs creds"]);

    applyTaskSideEffects(db, id, [
      { type: "clear_pending_actions" },
      { type: "clear_blocking_issues" },
    ], "awaiting_user", "execute");
    row = readTask(db, id);
    expect(row.pending_actions_json).toBe("[]");
    expect(row.blocking_issues_json).toBe("[]");
  });

  it("set_failure_count and reset_failure_count update retry_count", () => {
    const db = makeTestDb();
    const id = seedTask(db);
    applyTaskSideEffects(db, id, [{ type: "set_failure_count", count: 2 }], "plan", "plan");
    expect(readTask(db, id).retry_count).toBe(2);
    applyTaskSideEffects(db, id, [{ type: "reset_failure_count" }], "plan", "plan");
    expect(readTask(db, id).retry_count).toBe(0);
  });

  it("post_error_comment, post_cancellation_comment, post_review_comment, post_review_verdict insert system comments", () => {
    const db = makeTestDb();
    const id = seedTask(db);
    applyTaskSideEffects(db, id, [
      { type: "post_error_comment", message: "boom" },
      { type: "post_cancellation_comment", message: "Run cancelled." },
      { type: "post_review_comment", notes: "fix the bug" },
      { type: "post_review_verdict", verdict: "APPROVE" },
    ], "plan", "plan");
    const comments = db.prepare("SELECT body FROM task_comments WHERE task_id = ? ORDER BY rowid").all(id);
    expect(comments.map((c) => c.body)).toEqual([
      "ERROR: boom",
      "Run cancelled.",
      "fix the bug",
      "VERDICT: APPROVE",
    ]);
  });

  it("post_review_comment falls back to a default body when notes are blank", () => {
    const db = makeTestDb();
    const id = seedTask(db);
    applyTaskSideEffects(db, id, [{ type: "post_review_comment", notes: "   " }], "review", "execute");
    const comment = db.prepare("SELECT body FROM task_comments WHERE task_id = ?").get(id);
    expect(comment.body).toBe("Review rejected.");
  });

  it("set_plan_body writes body, plan_updated_at, plan_updated_by, plan_source_run_id atomically with stage", () => {
    const db = makeTestDb();
    const id = seedTask(db, { stage: "plan" });
    const runId = seedRun(db, id, "run-abc");
    applyTaskSideEffects(db, id, [
      { type: "set_plan_body", body: "## Plan\n\n1. Build", runId, updatedBy: "planner" },
    ], "plan", "execute", { now: 999 });
    const row = readTask(db, id);
    expect(row.stage).toBe("execute");
    expect(row.plan_body).toBe("## Plan\n\n1. Build");
    expect(row.plan_updated_at).toBe(999);
    expect(row.plan_updated_by).toBe("planner");
    expect(row.plan_source_run_id).toBe(runId);
  });

  it("set_plan_body defaults updatedBy to 'agent' when omitted", () => {
    const db = makeTestDb();
    const id = seedTask(db);
    const runId = seedRun(db, id, "run-1");
    applyTaskSideEffects(db, id, [
      { type: "set_plan_body", body: "x", runId },
    ], "plan", "plan");
    expect(readTask(db, id).plan_updated_by).toBe("agent");
  });

  it("set_plan_body with non-string body is a no-op for plan columns", () => {
    const db = makeTestDb();
    const id = seedTask(db);
    applyTaskSideEffects(db, id, [
      { type: "set_plan_body", body: null, runId: null },
    ], "plan", "plan");
    const row = readTask(db, id);
    // schema default for plan_body is '', not null
    expect(row.plan_body).toBe("");
    expect(row.plan_updated_at).toBeNull();
    expect(row.plan_source_run_id).toBeNull();
  });

  it("spawn_worker / spawn_reviewer / create_subtasks are intentional no-ops", () => {
    const db = makeTestDb();
    const id = seedTask(db, { stage: "execute" });
    applyTaskSideEffects(db, id, [
      { type: "spawn_worker", agentName: "x" },
      { type: "spawn_reviewer", agentName: "y" },
      { type: "create_subtasks", subtasks: [{ title: "child" }] },
    ], "execute", "review");
    const row = readTask(db, id);
    expect(row.stage).toBe("review");
    // No worker/process side-effects leaked into the row
    expect(row.error_text).toBeNull();
  });

  it("logs warnings for unknown side effect types when logger is provided", () => {
    const db = makeTestDb();
    const id = seedTask(db);
    const warnings = [];
    const logger = { warn: (...args) => warnings.push(args) };
    applyTaskSideEffects(db, id, [{ type: "totally-made-up" }], "plan", "plan", { logger });
    expect(warnings.length).toBe(1);
    expect(warnings[0][0]).toMatchObject({ taskId: id, type: "totally-made-up" });
  });

  it("error side effect surfaces via logger.warn", () => {
    const db = makeTestDb();
    const id = seedTask(db);
    const warnings = [];
    const logger = { warn: (...args) => warnings.push(args) };
    applyTaskSideEffects(db, id, [{ type: "error", message: "illegal transition" }], "plan", "plan", { logger });
    expect(warnings.length).toBe(1);
    expect(warnings[0][0]).toMatchObject({ taskId: id, message: "illegal transition" });
  });

  it("always bumps updated_at", () => {
    const db = makeTestDb();
    const id = seedTask(db);
    const before = readTask(db, id).updated_at;
    applyTaskSideEffects(db, id, [], "plan", "plan", { now: before + 5000 });
    expect(readTask(db, id).updated_at).toBe(before + 5000);
  });
});
