import { describe, it, expect } from "vitest";
import { makeTestDb } from "../helpers/test-db.js";
import {
  reconcileRequiredChildBlockedParents,
  resumeWaitingParents,
} from "../../core/task-joins.js";
import { applyTaskSideEffects } from "../../core/task-side-effects.js";
import { newTaskId } from "../../core/ids.js";

function seedTask(db, { id = newTaskId(), stage = "execute", parentId = null, title = "t" } = {}) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks (id, root_task_id, parent_task_id, title, stage, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, id, parentId, title, stage, now, now);
  return id;
}

function linkSubtask(db, parentId, childId, { required = 1 } = {}) {
  db.prepare(
    `INSERT INTO task_edges (parent_task_id, child_task_id, edge_type, required, created_at)
     VALUES (?, ?, 'subtask', ?, ?)`,
  ).run(parentId, childId, required, Date.now());
}

function makeApply(db) {
  const calls = [];
  return {
    calls,
    fn: (taskId, sideEffects, currentStage, newStage) => {
      calls.push({ taskId, sideEffects, currentStage, newStage });
      const tx = db.transaction(() => {
        applyTaskSideEffects(db, taskId, sideEffects, currentStage, newStage);
      });
      tx();
    },
  };
}

describe("resumeWaitingParents", () => {
  it("resumes a parent to execute when all required children are done", () => {
    const db = makeTestDb();
    const parent = seedTask(db, { stage: "awaiting_children" });
    const childA = seedTask(db, { stage: "done", parentId: parent });
    const childB = seedTask(db, { stage: "done", parentId: parent });
    linkSubtask(db, parent, childA);
    linkSubtask(db, parent, childB);

    const apply = makeApply(db);
    const ready = [];
    const resumed = resumeWaitingParents({
      db,
      childTaskId: childB,
      applySideEffects: apply.fn,
      onParentReady: (id) => ready.push(id),
    });

    expect(resumed).toEqual([{ parentId: parent, stage: "execute", reason: "children_completed" }]);
    expect(ready).toEqual([parent]);
    expect(db.prepare("SELECT stage FROM tasks WHERE id = ?").get(parent).stage).toBe("execute");
  });

  it("does not resume while a required sibling is still in progress", () => {
    const db = makeTestDb();
    const parent = seedTask(db, { stage: "awaiting_children" });
    const childA = seedTask(db, { stage: "done", parentId: parent });
    const childB = seedTask(db, { stage: "execute", parentId: parent });
    linkSubtask(db, parent, childA);
    linkSubtask(db, parent, childB);

    const apply = makeApply(db);
    const ready = [];
    const resumed = resumeWaitingParents({
      db, childTaskId: childA, applySideEffects: apply.fn, onParentReady: (id) => ready.push(id),
    });

    expect(resumed).toEqual([]);
    expect(ready).toEqual([]);
    expect(db.prepare("SELECT stage FROM tasks WHERE id = ?").get(parent).stage).toBe("awaiting_children");
  });

  it("ignores optional children when computing readiness", () => {
    const db = makeTestDb();
    const parent = seedTask(db, { stage: "awaiting_children" });
    const required = seedTask(db, { stage: "done", parentId: parent });
    const optional = seedTask(db, { stage: "execute", parentId: parent });
    linkSubtask(db, parent, required, { required: 1 });
    linkSubtask(db, parent, optional, { required: 0 });

    const apply = makeApply(db);
    const ready = [];
    resumeWaitingParents({
      db, childTaskId: required, applySideEffects: apply.fn, onParentReady: (id) => ready.push(id),
    });
    expect(db.prepare("SELECT stage FROM tasks WHERE id = ?").get(parent).stage).toBe("execute");
    expect(ready).toEqual([parent]);
  });

  it("blocks the parent when a required child is in stage=blocked", () => {
    const db = makeTestDb();
    const parent = seedTask(db, { stage: "awaiting_children" });
    const blocked = seedTask(db, { stage: "blocked", parentId: parent, title: "bad child" });
    linkSubtask(db, parent, blocked);

    const apply = makeApply(db);
    const ready = [];
    const resumed = resumeWaitingParents({
      db, childTaskId: blocked, applySideEffects: apply.fn, onParentReady: (id) => ready.push(id),
    });

    expect(resumed).toEqual([{ parentId: parent, stage: "blocked", reason: "child_blocked" }]);
    expect(ready).toEqual([]); // onParentReady is not invoked on the block path
    const row = db.prepare("SELECT stage, error_text FROM tasks WHERE id = ?").get(parent);
    expect(row.stage).toBe("blocked");
    expect(row.error_text).toMatch(/Required child blocked: bad child/);
  });

  it("resumes a required-child-blocked parent when the blocked child later finishes", () => {
    const db = makeTestDb();
    const parent = seedTask(db, { stage: "awaiting_children" });
    const blocked = seedTask(db, { stage: "blocked", parentId: parent, title: "bad child" });
    linkSubtask(db, parent, blocked);

    const apply = makeApply(db);
    resumeWaitingParents({ db, childTaskId: blocked, applySideEffects: apply.fn });
    db.prepare(`
      UPDATE tasks
      SET stage = 'done', stage_reason = NULL, error_text = NULL, blocking_issues_json = '[]'
      WHERE id = ?
    `).run(blocked);

    const ready = [];
    const resumed = resumeWaitingParents({
      db,
      childTaskId: blocked,
      applySideEffects: apply.fn,
      onParentReady: (id) => ready.push(id),
    });

    expect(resumed).toEqual([{ parentId: parent, stage: "execute", reason: "children_completed" }]);
    expect(ready).toEqual([parent]);
    const row = db.prepare("SELECT stage, error_text, stage_reason, blocking_issues_json FROM tasks WHERE id = ?").get(parent);
    expect(row).toMatchObject({
      stage: "execute",
      error_text: null,
      stage_reason: "required children completed",
      blocking_issues_json: "[]",
    });
  });

  it("moves a required-child-blocked parent back to awaiting_children when the child is unblocked but unfinished", () => {
    const db = makeTestDb();
    const parent = seedTask(db, { stage: "awaiting_children" });
    const child = seedTask(db, { stage: "blocked", parentId: parent, title: "bad child" });
    linkSubtask(db, parent, child);

    const apply = makeApply(db);
    resumeWaitingParents({ db, childTaskId: child, applySideEffects: apply.fn });
    db.prepare(`
      UPDATE tasks
      SET stage = 'execute', stage_reason = NULL, error_text = NULL, blocking_issues_json = '[]'
      WHERE id = ?
    `).run(child);

    const resumed = resumeWaitingParents({
      db,
      childTaskId: child,
      applySideEffects: apply.fn,
    });

    expect(resumed).toEqual([{ parentId: parent, stage: "awaiting_children", reason: "children_unblocked" }]);
    const row = db.prepare("SELECT stage, error_text, stage_reason, blocking_issues_json FROM tasks WHERE id = ?").get(parent);
    expect(row).toMatchObject({
      stage: "awaiting_children",
      error_text: null,
      stage_reason: "waiting for required children",
      blocking_issues_json: "[]",
    });
  });

  it("noops if the parent is not in awaiting_children", () => {
    const db = makeTestDb();
    const parent = seedTask(db, { stage: "execute" });
    const child = seedTask(db, { stage: "done", parentId: parent });
    linkSubtask(db, parent, child);

    const apply = makeApply(db);
    const resumed = resumeWaitingParents({
      db, childTaskId: child, applySideEffects: apply.fn,
    });
    expect(resumed).toEqual([]);
    expect(apply.calls).toEqual([]);
  });

  it("does not resume unrelated blocked parents", () => {
    const db = makeTestDb();
    const parent = seedTask(db, { stage: "blocked" });
    const child = seedTask(db, { stage: "done", parentId: parent });
    linkSubtask(db, parent, child);

    const apply = makeApply(db);
    const resumed = resumeWaitingParents({
      db,
      childTaskId: child,
      applySideEffects: apply.fn,
    });

    expect(resumed).toEqual([]);
    expect(apply.calls).toEqual([]);
    expect(db.prepare("SELECT stage FROM tasks WHERE id = ?").get(parent).stage).toBe("blocked");
  });

  it("noops if the parent has no required children", () => {
    const db = makeTestDb();
    const parent = seedTask(db, { stage: "awaiting_children" });
    const optional = seedTask(db, { stage: "done", parentId: parent });
    linkSubtask(db, parent, optional, { required: 0 });

    const apply = makeApply(db);
    const resumed = resumeWaitingParents({
      db, childTaskId: optional, applySideEffects: apply.fn,
    });
    expect(resumed).toEqual([]);
    expect(apply.calls).toEqual([]);
  });

  it("does not call onParentReady when callback is omitted", () => {
    const db = makeTestDb();
    const parent = seedTask(db, { stage: "awaiting_children" });
    const child = seedTask(db, { stage: "done", parentId: parent });
    linkSubtask(db, parent, child);
    const apply = makeApply(db);
    expect(() => resumeWaitingParents({ db, childTaskId: child, applySideEffects: apply.fn })).not.toThrow();
    expect(db.prepare("SELECT stage FROM tasks WHERE id = ?").get(parent).stage).toBe("execute");
  });
});

describe("reconcileRequiredChildBlockedParents", () => {
  it("repairs stale required-child blockers at startup", () => {
    const db = makeTestDb();
    const parent = seedTask(db, { stage: "blocked" });
    db.prepare(`
      UPDATE tasks
      SET stage_reason = 'required_child_blocked',
          error_text = 'Required child blocked: old child',
          blocking_issues_json = '["Required child blocked: old child"]'
      WHERE id = ?
    `).run(parent);
    const child = seedTask(db, { stage: "done", parentId: parent });
    linkSubtask(db, parent, child);

    const apply = makeApply(db);
    const ready = [];
    const reconciled = reconcileRequiredChildBlockedParents({
      db,
      applySideEffects: apply.fn,
      onParentReady: (id) => ready.push(id),
    });

    expect(reconciled).toEqual([{ parentId: parent, stage: "execute", reason: "children_completed" }]);
    expect(ready).toEqual([parent]);
    const row = db.prepare("SELECT stage, error_text, stage_reason, blocking_issues_json FROM tasks WHERE id = ?").get(parent);
    expect(row).toMatchObject({
      stage: "execute",
      error_text: null,
      stage_reason: "required children completed",
      blocking_issues_json: "[]",
    });
  });
});
