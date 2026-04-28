import { describe, it, expect, vi } from "vitest";
import { makeTestDb } from "../helpers/test-db.js";
import { createTaskWatcher } from "../../coordinator/task-watcher.js";
import { newTaskId } from "../../core/ids.js";
import { writeSettings } from "../../core/settings.js";

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

const advanceResult = {
  schema: "worklab.v2",
  stage: "execute",
  decision: "advance",
  summary: "implemented",
  details: "",
  artifacts: {},
  blocking_issues: [],
  pending_actions: [],
  subtasks: [],
};

describe("task-watcher", () => {
  it("handleRunRequested on execute task with owner and reviewer spawns work, then waits at review", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    seedAgent(db, "checker");
    const taskId = seedTask(db, { owner: "coder", reviewer: "checker" });
    const broker = stubBroker();
    const resolvers = [];
    const spawn = vi.fn(() => {
      let resolveDone;
      const done = new Promise((r) => { resolveDone = r; });
      resolvers.push(resolveDone);
      return { pid: 12345, done, cancel: vi.fn() };
    });
    const watcher = createTaskWatcher({ db, broker, spawn, workerBinary: "/fake" });
    await watcher.handleRunRequested(taskId);
    expect(spawn).toHaveBeenCalledTimes(1);
    const startEvent = broker.broadcasts.find((event) => event.p?.type === "run_started")?.p;
    expect(startEvent).toMatchObject({
      taskId,
      taskTitle: "t",
      mode: "execute",
      stage: "execute",
      agentName: "coder",
      status: "running",
      processStatus: "running",
    });
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    expect(task.stage).toBe("execute");
    db.prepare("UPDATE task_runs SET status = 'complete', process_status = 'succeeded', ended_at = ? WHERE id = ?")
      .run(Date.now(), startEvent.runId);
    resolvers[0]({ exitCode: 0, status: "complete", processStatus: "succeeded", finalText: "implemented", worklabResult: advanceResult });
    await new Promise((r) => setTimeout(r, 20));
    const after = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    expect(after.stage).toBe("review");
    expect(spawn).toHaveBeenCalledTimes(1);
    const endEvent = broker.broadcasts.find((event) => event.p?.type === "run_ended")?.p;
    expect(endEvent).toMatchObject({
      runId: startEvent.runId,
      taskId,
      taskTitle: "t",
      status: "complete",
      processStatus: "succeeded",
    });
  });

  it("broadcasts task_updated only after the new run row exists", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    const taskId = seedTask(db, { owner: "coder" });
    const broadcastRunCounts = [];
    const broker = {
      subscribe: () => {},
      unsubscribe: () => {},
      size: () => 0,
      broadcast: (channel, payload) => {
        if (channel === "global" && payload?.type === "task_updated") {
          const { count } = db
            .prepare("SELECT COUNT(*) AS count FROM task_runs WHERE task_id = ?")
            .get(taskId);
          broadcastRunCounts.push(count);
        }
      },
    };
    const spawn = vi.fn(() => ({
      pid: 12345,
      done: new Promise(() => {}),
      cancel: vi.fn(),
    }));

    const watcher = createTaskWatcher({ db, broker, spawn, workerBinary: "/fake" });
    await watcher.handleRunRequested(taskId);

    expect(broadcastRunCounts).toEqual([1]);
  });

  it("rejects run_requested on task without owner", async () => {
    const db = makeTestDb();
    const taskId = seedTask(db);
    const broker = stubBroker();
    const spawn = vi.fn();
    const watcher = createTaskWatcher({ db, broker, spawn, workerBinary: "/fake" });
    await expect(watcher.handleRunRequested(taskId)).rejects.toThrow(/no owner/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects run_requested when the task has an open blocker", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    const blockerId = seedTask(db, { owner: "coder" });
    const taskId = seedTask(db, { owner: "coder" });
    db.prepare(
      "INSERT INTO task_dependencies (task_id, depends_on_task_id, created_at) VALUES (?, ?, ?)",
    ).run(taskId, blockerId, Date.now());

    const watcher = createTaskWatcher({ db, broker: stubBroker(), spawn: vi.fn(), workerBinary: "/fake" });
    await expect(watcher.handleRunRequested(taskId)).rejects.toThrow(/blocked by/i);
  });

  it("auto-starts an opted-in dependent when its blocker is done", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    const blockerId = seedTask(db, { owner: "coder", stage: "execute" });
    const taskId = seedTask(db, { owner: "coder", stage: "execute", runPolicy: "auto_plan_execute" });
    db.prepare(
      "INSERT INTO task_dependencies (task_id, depends_on_task_id, created_at) VALUES (?, ?, ?)",
    ).run(taskId, blockerId, Date.now());
    db.prepare("UPDATE tasks SET stage = 'done' WHERE id = ?").run(blockerId);
    const spawn = vi.fn(() => ({ pid: 1, done: new Promise(() => {}), cancel: vi.fn() }));
    const watcher = createTaskWatcher({ db, broker: stubBroker(), spawn, workerBinary: "/fake" });

    watcher.maybeAutoStartDependents(blockerId);
    await new Promise((r) => setTimeout(r, 20));

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][0].taskId).toBe(taskId);
  });

  it("manual execute stage does not fake an active worker", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    const taskId = seedTask(db, { owner: "coder" });
    db.prepare("UPDATE tasks SET stage='execute' WHERE id=?").run(taskId);
    const handle = { pid: 1, done: new Promise(() => {}), cancel: vi.fn() };
    const watcher = createTaskWatcher({
      db,
      broker: stubBroker(),
      spawn: vi.fn(() => handle),
      workerBinary: "/fake",
    });
    await expect(watcher.handleRunRequested(taskId)).resolves.toMatchObject({ runId: expect.any(String) });
  });

  it("passes persisted worker timeout and cancel grace to spawned runs", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    const taskId = seedTask(db, { owner: "coder" });
    writeSettings(db, { worker_timeout_ms: 1234, cancel_grace_ms: 12 });
    const handle = { pid: 1, done: new Promise(() => {}), cancel: vi.fn() };
    const spawn = vi.fn(() => handle);
    const watcher = createTaskWatcher({
      db,
      broker: stubBroker(),
      spawn,
      workerBinary: "/fake",
      runTimeoutMs: 999999,
    });

    await watcher.handleRunRequested(taskId);

    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
      runTimeoutMs: 1234,
      cancelGraceMs: 12,
    }));
  });

  it("failed worker keeps task retryable in execute with error_text and error comment", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    const taskId = seedTask(db, { owner: "coder" });
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
    expect(task.stage).toBe("execute");
    expect(task.error_text).toBe("timeout");
    const comments = db
      .prepare("SELECT * FROM task_comments WHERE task_id = ?")
      .all(taskId);
    expect(comments.some((c) => c.body.includes("timeout"))).toBe(true);
    expect(comments.some((c) => c.author_type === "agent")).toBe(false);
  });

  it("successful worker exit without final output is invalid and does not advance", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    seedAgent(db, "checker");
    const taskId = seedTask(db, { owner: "coder", reviewer: "checker" });
    let resolveDone;
    const spawn = vi.fn(() => ({
      pid: 1,
      done: new Promise((r) => {
        resolveDone = r;
      }),
      cancel: vi.fn(),
    }));
    const watcher = createTaskWatcher({ db, broker: stubBroker(), spawn, workerBinary: "/fake" });
    await watcher.handleRunRequested(taskId);
    resolveDone({ exitCode: 0, status: "complete", processStatus: "succeeded" });
    await new Promise((r) => setTimeout(r, 20));
    const task = db.prepare("SELECT stage, error_text FROM tasks WHERE id = ?").get(taskId);
    expect(task.stage).toBe("execute");
    expect(task.error_text).toBe("invalid worklab_result");
    const comments = db
      .prepare("SELECT author_type, body FROM task_comments WHERE task_id = ? ORDER BY created_at")
      .all(taskId);
    expect(comments.some((c) => c.author_type === "agent")).toBe(false);
    expect(comments.some((c) => c.author_type === "system" && c.body.includes("invalid worklab_result"))).toBe(true);
  });

  it("reconciles stale running runs at boot", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    const taskId = seedTask(db, { owner: "coder" });
    const now = Date.now();
    db.prepare(
      "UPDATE tasks SET stage = 'execute', updated_at = ? WHERE id = ?",
    ).run(now, taskId);
    db.prepare(
      `INSERT INTO task_runs (id, task_id, mode, agent_name, status, started_at)
       VALUES ('stale1', ?, 'execute', 'coder', 'running', ?)`,
    ).run(taskId, now - 1000);

    const warn = vi.fn();
    createTaskWatcher({
      db,
      broker: stubBroker(),
      spawn: vi.fn(),
      workerBinary: "/fake",
      logger: { warn, info: vi.fn() },
    });

    const run = db.prepare("SELECT status, process_status, failure_kind, error_text FROM task_runs WHERE id = 'stale1'").get();
    expect(run.status).toBe("error");
    expect(run.process_status).toBe("abandoned");
    expect(run.failure_kind).toBe("abandoned");
    expect(run.error_text).toBe("coordinator restarted");
    const task = db.prepare("SELECT stage, stage_reason, error_text FROM tasks WHERE id = ?").get(taskId);
    expect(task.stage).toBe("execute");
    expect(task.stage_reason).toBe("abandoned");
    expect(task.error_text).toBe("Previous run did not finish");
    expect(warn).toHaveBeenCalled();
  });

  it("cancel() signals the active worker for that task", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    const taskId = seedTask(db, { owner: "coder" });
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
    const taskId = seedTask(db, { owner: "coder" });
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

  it("posts cleaned final text comments instead of structured summaries", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    const taskId = seedTask(db, { owner: "coder" });
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
    const worklabResult = {
      schema: "worklab.v2",
      stage: "execute",
      decision: "advance",
      summary: "File created",
      details: "Created `/tmp/test.txt`.",
      artifacts: {},
      blocking_issues: [],
      pending_actions: [],
      subtasks: [],
    };
    resolveDone({
      exitCode: 0,
      status: "complete",
      processStatus: "succeeded",
      finalText: `Created it.\n\n\`\`\`json\n${JSON.stringify(worklabResult)}\n\`\`\``,
      worklabResult,
    });
    await new Promise((r) => setTimeout(r, 20));
    const agentComment = db
      .prepare("SELECT body FROM task_comments WHERE task_id = ? AND author_type = 'agent'")
      .get(taskId);
    expect(agentComment.body).toBe("Created it.");
  });

  it("falls back to structured result comments when final text is only JSON", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    const taskId = seedTask(db, { owner: "coder" });
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
    const worklabResult = {
      schema: "worklab.v2",
      stage: "execute",
      decision: "advance",
      summary: "File created",
      details: "Created `/tmp/test.txt`.",
      artifacts: {},
      blocking_issues: [],
      pending_actions: [],
      subtasks: [],
    };
    resolveDone({
      exitCode: 0,
      status: "complete",
      processStatus: "succeeded",
      finalText: `\`\`\`json\n${JSON.stringify(worklabResult)}\n\`\`\``,
      worklabResult,
    });
    await new Promise((r) => setTimeout(r, 20));
    const agentComment = db
      .prepare("SELECT body FROM task_comments WHERE task_id = ? AND author_type = 'agent'")
      .get(taskId);
    expect(agentComment.body).toBe("File created\n\nCreated `/tmp/test.txt`.");
  });

  it("deduplicates generated plan body text", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    const taskId = seedTask(db, { owner: "coder" });
    db.prepare("UPDATE tasks SET stage = 'plan' WHERE id = ?").run(taskId);
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
    resolveDone({
      exitCode: 0,
      status: "complete",
      processStatus: "succeeded",
      finalText: "Plan A.\n\nPlan A.",
      worklabResult: {
        schema: "worklab.v2",
        stage: "plan",
        decision: "advance",
        summary: "Plan A.",
        details: "Plan A.\n\nPlan A.",
        artifacts: {},
        blocking_issues: [],
        pending_actions: [],
        subtasks: [],
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    const task = db.prepare("SELECT plan_body FROM tasks WHERE id = ?").get(taskId);
    expect(task.plan_body).toBe("Plan A.");
  });
});
