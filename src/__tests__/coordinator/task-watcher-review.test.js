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

function stubLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function seedAgent(db, name) {
  const now = Date.now();
  db.prepare(
    "INSERT INTO agents (name, display_name, sdk, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(name, name, "claude", "claude:claude-sonnet-4-6", now, now);
}

function seedTask(db, { executor = null, reviewer = null } = {}) {
  const id = newTaskId();
  const now = Date.now();
  db.prepare(
    "INSERT INTO tasks (id, title, status, executor_agent, reviewer_agent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, "t", "todo", executor, reviewer, now, now);
  return id;
}

/**
 * Creates a programmable spawn stub. Tests push scripts (or resolvers)
 * via `next()` or `push()` and the returned spawn pops them in FIFO order.
 */
function makeSpawn() {
  const calls = [];
  const scripts = [];
  const spawn = vi.fn((opts) => {
    calls.push(opts);
    const script = scripts.shift() || { auto: true, result: { exitCode: 0, status: "complete" } };
    let resolveDone;
    const done = new Promise((r) => { resolveDone = r; });
    const handle = {
      pid: 99000 + calls.length,
      done,
      cancel: vi.fn(),
    };
    if (script.auto) {
      queueMicrotask(() => resolveDone(script.result));
    } else {
      script.resolve = resolveDone;
    }
    return handle;
  });
  return {
    spawn,
    calls,
    /** Queue an auto-resolving script (resolves on microtask with `result`). */
    auto(result) { scripts.push({ auto: true, result }); },
    /** Queue a deferred script — returns a resolver fn for the test to call. */
    deferred() {
      const script = { auto: false };
      scripts.push(script);
      return () => script.resolve;
    },
  };
}

describe("task-watcher: reviewer loop + run_failed alignment", () => {
  it("executor failure now stays in_progress (not todo) and sets error_text via reducer", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    const taskId = seedTask(db, { executor: "coder" });
    const broker = stubBroker();
    const { spawn } = makeSpawn();
    // Override: we want a deferred executor to control the result
    let resolveDone;
    const handle = {
      pid: 1,
      done: new Promise((r) => { resolveDone = r; }),
      cancel: vi.fn(),
    };
    const spawnStub = vi.fn(() => handle);
    const watcher = createTaskWatcher({
      db, broker, spawn: spawnStub, workerBinary: "/fake",
    });

    await watcher.handleRunRequested(taskId);
    resolveDone({ exitCode: 1, status: "error", error: "boom" });
    await new Promise((r) => setTimeout(r, 20));

    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    expect(task.status).toBe("in_progress");
    expect(task.error_text).toBe("boom");

    const comments = db
      .prepare("SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at")
      .all(taskId);
    const errorComment = comments.find((c) => c.author_type === "system" && c.body.startsWith("ERROR:"));
    expect(errorComment).toBeTruthy();
    expect(errorComment.body).toBe("ERROR: boom");

    // Spawn was called once (executor), not a second time (no reviewer and failed)
    expect(spawnStub).toHaveBeenCalledTimes(1);
  });

  it("executor complete without reviewer parks in in_review (unchanged)", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    const taskId = seedTask(db, { executor: "coder" });
    const broker = stubBroker();
    let resolveDone;
    const handle = {
      pid: 1,
      done: new Promise((r) => { resolveDone = r; }),
      cancel: vi.fn(),
    };
    const spawnStub = vi.fn(() => handle);
    const watcher = createTaskWatcher({ db, broker, spawn: spawnStub, workerBinary: "/fake" });

    await watcher.handleRunRequested(taskId);
    resolveDone({ exitCode: 0, status: "complete", finalText: "done" });
    await new Promise((r) => setTimeout(r, 20));

    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    expect(task.status).toBe("in_review");
    expect(spawnStub).toHaveBeenCalledTimes(1);

    const agentComments = db
      .prepare("SELECT * FROM task_comments WHERE task_id = ? AND author_type='agent'")
      .all(taskId);
    expect(agentComments).toHaveLength(1);
    expect(agentComments[0].body).toBe("done");

    const runs = db.prepare("SELECT * FROM task_runs WHERE task_id = ?").all(taskId);
    expect(runs).toHaveLength(1);
    expect(runs[0].mode).toBe("execute");
  });

  it("executor complete with reviewer → reviewer spawned with APPROVE → task done", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    seedAgent(db, "checker");
    const taskId = seedTask(db, { executor: "coder", reviewer: "checker" });
    const broker = stubBroker();

    // Two sequential handles — executor, then reviewer.
    const handles = [];
    const resolvers = [];
    const spawnStub = vi.fn(() => {
      let resolve;
      const done = new Promise((r) => { resolve = r; });
      const h = { pid: 1000 + handles.length, done, cancel: vi.fn() };
      handles.push(h);
      resolvers.push(resolve);
      return h;
    });

    const watcher = createTaskWatcher({ db, broker, spawn: spawnStub, workerBinary: "/fake" });
    await watcher.handleRunRequested(taskId);

    // Executor completes with final text
    resolvers[0]({ exitCode: 0, status: "complete", finalText: "executor output" });
    await new Promise((r) => setTimeout(r, 20));

    // Reviewer should have been spawned
    expect(spawnStub).toHaveBeenCalledTimes(2);
    const reviewerCall = spawnStub.mock.calls[1][0];
    expect(reviewerCall.args).toEqual(
      expect.arrayContaining(["--mode", "review", "--agent", "checker"]),
    );

    // Reviewer emits APPROVE
    resolvers[1]({
      exitCode: 0,
      status: "complete",
      finalText: "VERDICT: APPROVE",
      events: [
        { type: "verdict", verdict: "APPROVE", notes: "" },
      ],
    });
    await new Promise((r) => setTimeout(r, 20));

    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    expect(task.status).toBe("done");
    expect(task.completed_at).toBeTruthy();

    const runs = db
      .prepare("SELECT * FROM task_runs WHERE task_id = ? ORDER BY rowid")
      .all(taskId);
    expect(runs).toHaveLength(2);
    expect(runs[0].mode).toBe("execute");
    expect(runs[1].mode).toBe("review");
    expect(runs[1].agent_name).toBe("checker");

    const comments = db
      .prepare("SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at")
      .all(taskId);
    // Executor agent comment + reviewer agent comment + system VERDICT comment
    const reviewerAgentComment = comments.find(
      (c) => c.author_type === "agent" && c.author_id === "checker",
    );
    expect(reviewerAgentComment).toBeTruthy();
    expect(reviewerAgentComment.body).toBe("VERDICT: APPROVE");
    const verdictSystemComment = comments.find(
      (c) => c.author_type === "system" && c.body === "VERDICT: APPROVE",
    );
    expect(verdictSystemComment).toBeTruthy();
  });

  it("executor complete with reviewer → reviewer REJECT → back to in_progress, error_text cleared", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    seedAgent(db, "checker");
    const taskId = seedTask(db, { executor: "coder", reviewer: "checker" });
    // Pretend there's an old error_text lingering — reducer clears it on rejection
    db.prepare("UPDATE tasks SET error_text = 'stale' WHERE id = ?").run(taskId);
    const broker = stubBroker();

    const resolvers = [];
    const spawnStub = vi.fn(() => {
      let resolve;
      const done = new Promise((r) => { resolve = r; });
      resolvers.push(resolve);
      return { pid: 1000 + resolvers.length, done, cancel: vi.fn() };
    });

    const watcher = createTaskWatcher({ db, broker, spawn: spawnStub, workerBinary: "/fake" });
    await watcher.handleRunRequested(taskId);

    resolvers[0]({ exitCode: 0, status: "complete", finalText: "executor output" });
    await new Promise((r) => setTimeout(r, 20));

    resolvers[1]({
      exitCode: 0,
      status: "complete",
      finalText: "VERDICT: REJECT\n\nMissing tests.",
      events: [
        { type: "verdict", verdict: "REJECT", notes: "Missing tests." },
      ],
    });
    await new Promise((r) => setTimeout(r, 20));

    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    expect(task.status).toBe("in_progress");
    expect(task.error_text).toBeNull();

    const comments = db
      .prepare("SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at")
      .all(taskId);
    const reviewerAgentComment = comments.find(
      (c) => c.author_type === "agent" && c.author_id === "checker",
    );
    expect(reviewerAgentComment).toBeTruthy();
    expect(reviewerAgentComment.body).toBe("VERDICT: REJECT\n\nMissing tests.");

    const systemComment = comments.find(
      (c) => c.author_type === "system" && c.body.includes("Missing tests"),
    );
    expect(systemComment).toBeTruthy();
  });

  it("reviewer emits no VERDICT → task stays in_review, system warning posted, logger.warn called, error_text set", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    seedAgent(db, "checker");
    const taskId = seedTask(db, { executor: "coder", reviewer: "checker" });
    const broker = stubBroker();
    const logger = stubLogger();

    const resolvers = [];
    const spawnStub = vi.fn(() => {
      let resolve;
      const done = new Promise((r) => { resolve = r; });
      resolvers.push(resolve);
      return { pid: 1000 + resolvers.length, done, cancel: vi.fn() };
    });

    const watcher = createTaskWatcher({ db, broker, spawn: spawnStub, workerBinary: "/fake", logger });
    await watcher.handleRunRequested(taskId);

    resolvers[0]({ exitCode: 0, status: "complete", finalText: "executor output" });
    await new Promise((r) => setTimeout(r, 20));

    // Reviewer doesn't emit a verdict event AND finalText has no VERDICT line
    resolvers[1]({
      exitCode: 0,
      status: "complete",
      finalText: "Looks good to me",
      events: [],
    });
    await new Promise((r) => setTimeout(r, 20));

    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    expect(task.status).toBe("in_review");
    expect(task.error_text).toBe("Reviewer did not emit a VERDICT line");

    const comments = db
      .prepare("SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at")
      .all(taskId);
    const warning = comments.find(
      (c) => c.author_type === "system" && c.body.includes("VERDICT"),
    );
    expect(warning).toBeTruthy();
    expect(warning.body).toMatch(/did not emit/i);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ taskId, runId: expect.any(String), reviewerAgent: "checker" }),
      "reviewer did not emit VERDICT line",
    );
  });

  it("reviewer spawn env includes WORKLAB_PRIOR_RUN_ID referencing the execute run", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    seedAgent(db, "checker");
    const taskId = seedTask(db, { executor: "coder", reviewer: "checker" });
    const broker = stubBroker();

    const calls = [];
    const resolvers = [];
    const spawnStub = vi.fn((opts) => {
      calls.push(opts);
      let resolve;
      const done = new Promise((r) => { resolve = r; });
      resolvers.push(resolve);
      return { pid: 1000 + resolvers.length, done, cancel: vi.fn() };
    });

    const watcher = createTaskWatcher({ db, broker, spawn: spawnStub, workerBinary: "/fake" });
    const { runId: executeRunId } = await watcher.handleRunRequested(taskId);

    resolvers[0]({ exitCode: 0, status: "complete", finalText: "executor output" });
    await new Promise((r) => setTimeout(r, 20));

    expect(calls).toHaveLength(2);
    const reviewerOpts = calls[1];
    expect(reviewerOpts.env).toBeDefined();
    expect(reviewerOpts.env.WORKLAB_PRIOR_RUN_ID).toBe(executeRunId);

    // Cleanup — resolve second spawn
    resolvers[1]({
      exitCode: 0,
      status: "complete",
      finalText: "VERDICT: APPROVE",
      events: [{ type: "verdict", verdict: "APPROVE", notes: "" }],
    });
    await new Promise((r) => setTimeout(r, 20));
  });

  // Issue B: state drift test — illegal transition on run exit
  it("state drift: task manually set to todo before execute completes → State drift comment, logger.error, no status change", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    const taskId = seedTask(db, { executor: "coder" });
    const broker = stubBroker();
    const logger = stubLogger();

    let resolveDone;
    const handle = {
      pid: 1,
      done: new Promise((r) => { resolveDone = r; }),
      cancel: vi.fn(),
    };
    const spawnStub = vi.fn(() => handle);
    const watcher = createTaskWatcher({ db, broker, spawn: spawnStub, workerBinary: "/fake", logger });

    await watcher.handleRunRequested(taskId);

    // Externally flip task status from in_progress → todo before worker exits
    db.prepare("UPDATE tasks SET status = 'todo' WHERE id = ?").run(taskId);

    // Now simulate worker completing successfully
    resolveDone({ exitCode: 0, status: "complete", finalText: "done" });
    await new Promise((r) => setTimeout(r, 20));

    // Task status should remain whatever the manual override was (todo)
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    expect(task.status).toBe("todo");

    // State drift comment must be present
    const comments = db
      .prepare("SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at")
      .all(taskId);
    const driftComment = comments.find(
      (c) => c.author_type === "system" && c.body.startsWith("State drift:"),
    );
    expect(driftComment).toBeTruthy();
    expect(driftComment.body).toMatch(/State drift:/);

    // logger.error must have been called with the illegal transition message
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ taskId, message: expect.any(String) }),
      "illegal transition on run exit",
    );
  });

  // Issue B: state drift for reviewer path — illegal review_approved transition
  it("state drift: task manually set to in_progress before reviewer approves → State drift comment, logger.error", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    seedAgent(db, "checker");
    const taskId = seedTask(db, { executor: "coder", reviewer: "checker" });
    const broker = stubBroker();
    const logger = stubLogger();

    const resolvers = [];
    const spawnStub = vi.fn(() => {
      let resolve;
      const done = new Promise((r) => { resolve = r; });
      resolvers.push(resolve);
      return { pid: 1000 + resolvers.length, done, cancel: vi.fn() };
    });

    const watcher = createTaskWatcher({ db, broker, spawn: spawnStub, workerBinary: "/fake", logger });
    await watcher.handleRunRequested(taskId);

    // Executor completes — task goes to in_review, reviewer spawned
    resolvers[0]({ exitCode: 0, status: "complete", finalText: "executor output" });
    await new Promise((r) => setTimeout(r, 20));

    // Manually flip task from in_review → in_progress before reviewer exits
    db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(taskId);

    // Reviewer approves
    resolvers[1]({
      exitCode: 0,
      status: "complete",
      finalText: "VERDICT: APPROVE",
      events: [{ type: "verdict", verdict: "APPROVE", notes: "" }],
    });
    await new Promise((r) => setTimeout(r, 20));

    // Task status should remain in_progress (manual override preserved)
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    expect(task.status).toBe("in_progress");

    // State drift comment must be present
    const comments = db
      .prepare("SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at")
      .all(taskId);
    const driftComment = comments.find(
      (c) => c.author_type === "system" && c.body.startsWith("State drift:"),
    );
    expect(driftComment).toBeTruthy();

    // logger.error must have been called
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ taskId, message: expect.any(String) }),
      "illegal transition on run exit",
    );
  });

  // Issue F: reviewer cancelled
  it("reviewer cancelled → task stays in_review, system comment contains 'cancel'", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    seedAgent(db, "checker");
    const taskId = seedTask(db, { executor: "coder", reviewer: "checker" });
    const broker = stubBroker();
    const logger = stubLogger();

    const resolvers = [];
    const spawnStub = vi.fn(() => {
      let resolve;
      const done = new Promise((r) => { resolve = r; });
      resolvers.push(resolve);
      return { pid: 1000 + resolvers.length, done, cancel: vi.fn() };
    });

    const watcher = createTaskWatcher({ db, broker, spawn: spawnStub, workerBinary: "/fake", logger });
    await watcher.handleRunRequested(taskId);

    resolvers[0]({ exitCode: 0, status: "complete", finalText: "executor output" });
    await new Promise((r) => setTimeout(r, 20));

    // Reviewer exits cancelled
    resolvers[1]({ exitCode: 130, status: "cancelled", finalText: null, events: [] });
    await new Promise((r) => setTimeout(r, 20));

    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    expect(task.status).toBe("in_review");

    const comments = db
      .prepare("SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at")
      .all(taskId);
    const cancelComment = comments.find(
      (c) => c.author_type === "system" && c.body.toLowerCase().includes("cancel"),
    );
    expect(cancelComment).toBeTruthy();
  });

  // Issue F: reviewer exits with error
  it("reviewer exits with error → task stays in_review, system comment contains error message", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    seedAgent(db, "checker");
    const taskId = seedTask(db, { executor: "coder", reviewer: "checker" });
    const broker = stubBroker();
    const logger = stubLogger();

    const resolvers = [];
    const spawnStub = vi.fn(() => {
      let resolve;
      const done = new Promise((r) => { resolve = r; });
      resolvers.push(resolve);
      return { pid: 1000 + resolvers.length, done, cancel: vi.fn() };
    });

    const watcher = createTaskWatcher({ db, broker, spawn: spawnStub, workerBinary: "/fake", logger });
    await watcher.handleRunRequested(taskId);

    resolvers[0]({ exitCode: 0, status: "complete", finalText: "executor output" });
    await new Promise((r) => setTimeout(r, 20));

    // Reviewer exits with error
    resolvers[1]({ exitCode: 1, status: "error", error: "reviewer crashed", finalText: null, events: [] });
    await new Promise((r) => setTimeout(r, 20));

    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    expect(task.status).toBe("in_review");

    const comments = db
      .prepare("SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at")
      .all(taskId);
    const errorComment = comments.find(
      (c) => c.author_type === "system" && (c.body.toLowerCase().includes("fail") || c.body.includes("reviewer crashed")),
    );
    expect(errorComment).toBeTruthy();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ taskId, message: "reviewer crashed" }),
      "review run failed",
    );
  });
});
