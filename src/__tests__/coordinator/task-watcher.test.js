import { describe, it, expect, vi } from "vitest";
import { makeTestDb } from "../helpers/test-db.js";
import { createTaskWatcher } from "../../coordinator/task-watcher.js";
import { newTaskId } from "../../core/ids.js";

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

function seedAgent(db, name = "coder") {
  const now = Date.now();
  db.prepare(
    "INSERT INTO agents (name, display_name, sdk, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(name, name, "claude", "sonnet", now, now);
}

function seedTask(db, { executor = null, reviewer = null } = {}) {
  const id = newTaskId();
  const now = Date.now();
  db.prepare(
    "INSERT INTO tasks (id, title, status, executor_agent, reviewer_agent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, "t", "todo", executor, reviewer, now, now);
  return id;
}

describe("task-watcher", () => {
  it("handleRunRequested on todo task with executor spawns worker and flips to in_progress", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    const taskId = seedTask(db, { executor: "coder" });
    const broker = stubBroker();
    let resolveDone;
    const spawn = vi.fn(() => ({
      pid: 12345,
      done: new Promise((r) => {
        resolveDone = r;
      }),
      cancel: vi.fn(),
    }));
    const watcher = createTaskWatcher({ db, broker, spawn, workerBinary: "/fake" });
    await watcher.handleRunRequested(taskId);
    expect(spawn).toHaveBeenCalledTimes(1);
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    expect(task.status).toBe("in_progress");
    resolveDone({ exitCode: 0, status: "complete" });
    await new Promise((r) => setTimeout(r, 20));
    const after = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    expect(after.status).toBe("in_review");
  });

  it("rejects run_requested on task without executor", async () => {
    const db = makeTestDb();
    const taskId = seedTask(db);
    const broker = stubBroker();
    const spawn = vi.fn();
    const watcher = createTaskWatcher({ db, broker, spawn, workerBinary: "/fake" });
    await expect(watcher.handleRunRequested(taskId)).rejects.toThrow(/no executor/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects run_requested when task already in_progress", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    const taskId = seedTask(db, { executor: "coder" });
    db.prepare("UPDATE tasks SET status='in_progress' WHERE id=?").run(taskId);
    const watcher = createTaskWatcher({
      db,
      broker: stubBroker(),
      spawn: vi.fn(),
      workerBinary: "/fake",
    });
    await expect(watcher.handleRunRequested(taskId)).rejects.toThrow(/already/i);
  });

  it("failed worker moves task back to todo and adds error comment", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    const taskId = seedTask(db, { executor: "coder" });
    const broker = stubBroker();
    let resolveDone;
    const spawn = vi.fn(() => ({
      pid: 1,
      done: new Promise((r) => {
        resolveDone = r;
      }),
      cancel: vi.fn(),
    }));
    const watcher = createTaskWatcher({ db, broker, spawn, workerBinary: "/fake" });
    await watcher.handleRunRequested(taskId);
    resolveDone({ exitCode: 1, status: "error", error: "timeout" });
    await new Promise((r) => setTimeout(r, 20));
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    expect(task.status).toBe("todo");
    expect(task.error_text).toBe("timeout");
    const comments = db
      .prepare("SELECT * FROM task_comments WHERE task_id = ?")
      .all(taskId);
    expect(comments.some((c) => c.body.includes("timeout"))).toBe(true);
  });

  it("cancel() signals the active worker for that task", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    const taskId = seedTask(db, { executor: "coder" });
    const cancelFn = vi.fn();
    const spawn = vi.fn(() => ({
      pid: 1,
      done: new Promise(() => {}),
      cancel: cancelFn,
    }));
    const watcher = createTaskWatcher({
      db,
      broker: stubBroker(),
      spawn,
      workerBinary: "/fake",
    });
    await watcher.handleRunRequested(taskId);
    watcher.cancel(taskId);
    expect(cancelFn).toHaveBeenCalled();
  });

  it("final text posted as an agent comment on clean completion", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    const taskId = seedTask(db, { executor: "coder" });
    let resolveDone;
    const spawn = vi.fn(() => ({
      pid: 1,
      done: new Promise((r) => {
        resolveDone = r;
      }),
      cancel: vi.fn(),
    }));
    const watcher = createTaskWatcher({
      db,
      broker: stubBroker(),
      spawn,
      workerBinary: "/fake",
    });
    await watcher.handleRunRequested(taskId);
    resolveDone({ exitCode: 0, status: "complete", finalText: "I did the thing." });
    await new Promise((r) => setTimeout(r, 20));
    const comments = db
      .prepare("SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at")
      .all(taskId);
    const agentComment = comments.find((c) => c.author_type === "agent");
    expect(agentComment).toBeTruthy();
    expect(agentComment.body).toBe("I did the thing.");
  });
});
