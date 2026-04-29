import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestDb } from "../helpers/test-db.js";
import { createTaskWatcher } from "../../coordinator/task-watcher.js";
import { newTaskId } from "../../core/ids.js";
import { writeSettings } from "../../core/settings.js";
import { kbList, kbRead } from "../../core/kb.js";
import { slugify } from "../../core/slugs.js";

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

function seedTask(db, { owner = null, planner = null, reviewer = null, stage = "execute", runPolicy = "manual", projectId = null } = {}) {
  const id = newTaskId();
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks
      (id, root_task_id, project_id, title, stage, owner_agent, planner_agent, reviewer_agent, run_policy, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, id, projectId, "t", stage, owner, planner, reviewer, runPolicy, now, now);
  return id;
}

function seedProject(db, patch = {}) {
  const now = Date.now();
  const project = {
    id: patch.id || "project-1",
    slug: patch.slug || "project-one",
    name: patch.name || "Project One",
    description: patch.description || "Project description.",
    context: patch.context || "Project context.",
    workdir: patch.workdir || null,
  };
  db.prepare(`
    INSERT INTO projects
      (id, slug, name, description, context_markdown, workdir, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(project.id, project.slug, project.name, project.description, project.context, project.workdir, now, now);
  return project;
}

function tempDataDir() {
  return mkdtempSync(join(tmpdir(), "worklab-rich-final-"));
}

function richFinalAnswer() {
  return `# Complete Restaurant Research

## Summary

I researched several Kyoto kaiseki options and found a practical shortlist for the team dinner. The best fit is Iharada because it keeps the all-in price under the stated budget while still offering private rooms, online booking, and a serious seasonal menu.

## Recommended options

1. Iharada is the strongest fit for a team because the price is predictable, the location is reachable by taxi, and private rooms can handle a larger group.
2. Machiya Locals is a useful fallback for smaller teams that want a simple English booking flow and prepaid confirmation.
3. Minokichi is the safest large-group fallback when capacity matters more than a hidden-gem atmosphere.

## Caveats

The name Kaisei appears to be a spelling mix-up with kaiseki. Booking should happen quickly because the requested May dates are close. Dietary restrictions need confirmation before booking because traditional kaiseki menus may not adapt well at short notice.

## Sources checked

- Official restaurant pages
- English booking platforms
- Michelin and dining guide references
- Platform pages with current price ranges

## Next step

Open the booking page for Iharada first. If the preferred date is unavailable, move to Machiya Locals for a smaller group or Minokichi for a larger group.`;
}

function kbWriteEvents({ slug, toolName = "mcp__worklab__kb_create", isError = false } = {}) {
  return [
    {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "kb-1", name: toolName, input: { slug, title: "Research", body: "Full report" } }],
      },
    },
    {
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "kb-1",
          content: JSON.stringify(isError ? { ok: false, error: "failed" } : { ok: true, slug }),
          is_error: isError,
        }],
      },
    },
  ];
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

  it("uses planner assignment for plan runs and falls back to owner", async () => {
    const db = makeTestDb();
    seedAgent(db, "owner");
    seedAgent(db, "planner");
    const plannedTaskId = seedTask(db, { owner: "owner", planner: "planner", stage: "plan" });
    const fallbackTaskId = seedTask(db, { owner: "owner", stage: "plan" });
    const broker = stubBroker();
    const spawn = vi.fn(() => ({
      pid: 1,
      done: new Promise(() => {}),
      cancel: vi.fn(),
    }));
    const watcher = createTaskWatcher({ db, broker, spawn, workerBinary: "/fake" });

    await watcher.handleRunRequested(plannedTaskId);
    await watcher.handleRunRequested(fallbackTaskId);

    expect(spawn.mock.calls[0][0].args).toEqual(["--task", plannedTaskId, "--mode", "plan", "--agent", "planner"]);
    expect(spawn.mock.calls[1][0].args).toEqual(["--task", fallbackTaskId, "--mode", "plan", "--agent", "owner"]);
  });

  it("uses project workdir and records project metadata when spawning a run", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    const workdir = mkdtempSync(join(tmpdir(), "worklab-project-workdir-"));
    const project = seedProject(db, { workdir, context: "Always use the project checkout." });
    const taskId = seedTask(db, { owner: "coder", projectId: project.id });
    const spawn = vi.fn(() => ({ pid: 1, done: new Promise(() => {}), cancel: vi.fn() }));
    const watcher = createTaskWatcher({
      db,
      broker: stubBroker(),
      spawn,
      workerBinary: "/fake",
      workspace: "/default-workspace",
      repoRoot: "/repo",
    });

    const { runId } = await watcher.handleRunRequested(taskId);

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][0].env).toMatchObject({
      WORKLAB_WORKSPACE: workdir,
      WORKLAB_PROJECT_ID: project.id,
      WORKLAB_PROJECT_SLUG: project.slug,
      WORKLAB_PROJECT_NAME: project.name,
    });
    const run = db.prepare("SELECT project_id, workdir, project_context_hash FROM task_runs WHERE id = ?").get(runId);
    expect(run).toMatchObject({ project_id: project.id, workdir });
    expect(run.project_context_hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("delegated subtasks inherit the parent project", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    const project = seedProject(db);
    const taskId = seedTask(db, { owner: "coder", projectId: project.id });
    let resolveDone;
    const spawn = vi.fn(() => ({
      pid: 1,
      done: new Promise((resolve) => { resolveDone = resolve; }),
      cancel: vi.fn(),
    }));
    const watcher = createTaskWatcher({ db, broker: stubBroker(), spawn, workerBinary: "/fake" });
    await watcher.handleRunRequested(taskId);

    resolveDone({
      exitCode: 0,
      status: "complete",
      processStatus: "succeeded",
      finalText: "Delegated.",
      worklabResult: {
        schema: "worklab.v2",
        stage: "execute",
        decision: "delegate",
        summary: "Delegated",
        details: "",
        artifacts: {},
        blocking_issues: [],
        pending_actions: [],
        subtasks: [{ title: "Child work", instructions: "Do child work." }],
      },
    });
    await new Promise((r) => setTimeout(r, 20));

    const child = db.prepare("SELECT project_id, title FROM tasks WHERE parent_task_id = ?").get(taskId);
    expect(child).toMatchObject({ project_id: project.id, title: "Child work" });
  });

  it("rejects plan run_requested without planner or owner", async () => {
    const db = makeTestDb();
    const taskId = seedTask(db, { stage: "plan" });
    const broker = stubBroker();
    const spawn = vi.fn();
    const watcher = createTaskWatcher({ db, broker, spawn, workerBinary: "/fake" });
    await expect(watcher.handleRunRequested(taskId)).rejects.toThrow(/no planner or owner/i);
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

  it("prefers structured final_text over process-prefaced final JSON comments", async () => {
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
      final_text: "Done. Created `/tmp/test.txt`.",
      artifacts: {},
      blocking_issues: [],
      pending_actions: [],
      subtasks: [],
    };
    resolveDone({
      exitCode: 0,
      status: "complete",
      processStatus: "succeeded",
      finalText: `Now I'll output the final structured Worklab result.\n\n\`\`\`json\n${JSON.stringify(worklabResult)}\n\`\`\``,
      worklabResult,
    });
    await new Promise((r) => setTimeout(r, 20));
    const agentComment = db
      .prepare("SELECT body FROM task_comments WHERE task_id = ? AND author_type = 'agent'")
      .get(taskId);
    expect(agentComment.body).toBe("Done. Created `/tmp/test.txt`.");
  });

  it("stores substantial final prose in knowledge and links it from the agent comment", async () => {
    const db = makeTestDb();
    const dataDir = tempDataDir();
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
      dataDir,
    });
    const { runId } = await watcher.handleRunRequested(taskId);
    const fullAnswer = richFinalAnswer();
    const worklabResult = {
      schema: "worklab.v2",
      stage: "execute",
      decision: "advance",
      summary: "Restaurant research complete",
      details: "Iharada is the top pick.",
      final_text: "Research complete. Iharada is the top pick.",
      artifacts: {},
      blocking_issues: [],
      pending_actions: [],
      subtasks: [],
    };
    resolveDone({
      exitCode: 0,
      status: "complete",
      processStatus: "succeeded",
      finalText: `${fullAnswer}\n\n\`\`\`json\n${JSON.stringify(worklabResult)}\n\`\`\``,
      worklabResult,
    });
    await new Promise((r) => setTimeout(r, 20));

    const slug = slugify(`run-${runId}`, "run-result");
    const entry = kbRead({ dataDir, slug });
    expect(entry.meta.category).toBe("run-results");
    expect(entry.meta.tags).toEqual(expect.arrayContaining(["run-result", "execute", "agent-coder"]));
    expect(entry.body).toContain("# Complete Restaurant Research");
    expect(entry.body).toContain(`/api/runs/${runId}/raw-log`);
    expect(entry.body).not.toContain('"schema": "worklab.v2"');

    const agentComment = db
      .prepare("SELECT body FROM task_comments WHERE task_id = ? AND author_type = 'agent'")
      .get(taskId);
    expect(agentComment.body).toBe(`Research complete. Iharada is the top pick.\n\nFull final answer: [Knowledge entry](#/knowledge/${slug})`);
  });

  it("stores Codex-style assistant prose in knowledge when finalText is only the structured comment", async () => {
    const db = makeTestDb();
    const dataDir = tempDataDir();
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
      dataDir,
    });
    const { runId } = await watcher.handleRunRequested(taskId);
    const fullAnswer = richFinalAnswer();
    const worklabResult = {
      schema: "worklab.v2",
      stage: "execute",
      decision: "advance",
      summary: "Restaurant research complete",
      details: "Iharada is the top pick.",
      final_text: "Research complete. Iharada is the top pick.",
      artifacts: {},
      blocking_issues: [],
      pending_actions: [],
      subtasks: [],
    };
    resolveDone({
      exitCode: 0,
      status: "complete",
      processStatus: "succeeded",
      finalText: worklabResult.final_text,
      worklabResult,
      events: [
        {
          type: "sdk_event",
          event: {
            type: "assistant",
            message: { content: [{ type: "text", text: fullAnswer }] },
          },
        },
      ],
    });
    await new Promise((r) => setTimeout(r, 20));

    const slug = slugify(`run-${runId}`, "run-result");
    const entry = kbRead({ dataDir, slug });
    expect(entry.body).toContain("# Complete Restaurant Research");
    expect(entry.body).toContain("Source run:");
    const agentComment = db
      .prepare("SELECT body FROM task_comments WHERE task_id = ? AND author_type = 'agent'")
      .get(taskId);
    expect(agentComment.body).toBe(`Research complete. Iharada is the top pick.\n\nFull final answer: [Knowledge entry](#/knowledge/${slug})`);
  });

  it("does not create fallback knowledge when final text already links a knowledge entry", async () => {
    const db = makeTestDb();
    const dataDir = tempDataDir();
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
      dataDir,
    });
    const { runId } = await watcher.handleRunRequested(taskId);
    const fullAnswer = richFinalAnswer();
    const explicitSlug = "restaurant-research";
    const linkedFinalText = `Research complete. Iharada is the top pick.\n\nFull final answer: [Knowledge entry](#/knowledge/${explicitSlug})`;
    const worklabResult = {
      schema: "worklab.v2",
      stage: "execute",
      decision: "advance",
      summary: "Restaurant research complete",
      details: "Iharada is the top pick.",
      final_text: linkedFinalText,
      artifacts: {},
      blocking_issues: [],
      pending_actions: [],
      subtasks: [],
    };
    resolveDone({
      exitCode: 0,
      status: "complete",
      processStatus: "succeeded",
      finalText: `${fullAnswer}\n\n\`\`\`json\n${JSON.stringify(worklabResult)}\n\`\`\``,
      worklabResult,
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(kbRead({ dataDir, slug: slugify(`run-${runId}`, "run-result") })).toBeNull();
    const agentComment = db
      .prepare("SELECT body FROM task_comments WHERE task_id = ? AND author_type = 'agent'")
      .get(taskId);
    expect(agentComment.body).toBe(linkedFinalText);
  });

  it("links an explicit successful KB write instead of creating fallback knowledge", async () => {
    const db = makeTestDb();
    const dataDir = tempDataDir();
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
      dataDir,
    });
    const { runId } = await watcher.handleRunRequested(taskId);
    const explicitSlug = "restaurant-research";
    const fullAnswer = richFinalAnswer();
    const worklabResult = {
      schema: "worklab.v2",
      stage: "execute",
      decision: "advance",
      summary: "Restaurant research complete",
      details: "Iharada is the top pick.",
      final_text: "Research complete. Iharada is the top pick.",
      artifacts: {},
      blocking_issues: [],
      pending_actions: [],
      subtasks: [],
    };
    resolveDone({
      exitCode: 0,
      status: "complete",
      processStatus: "succeeded",
      finalText: `${fullAnswer}\n\n\`\`\`json\n${JSON.stringify(worklabResult)}\n\`\`\``,
      worklabResult,
      events: kbWriteEvents({ slug: explicitSlug }),
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(kbRead({ dataDir, slug: slugify(`run-${runId}`, "run-result") })).toBeNull();
    const agentComment = db
      .prepare("SELECT body FROM task_comments WHERE task_id = ? AND author_type = 'agent'")
      .get(taskId);
    expect(agentComment.body).toBe(`Research complete. Iharada is the top pick.\n\nFull final answer: [Knowledge entry](#/knowledge/${explicitSlug})`);
  });

  it("creates fallback knowledge when the explicit KB write failed", async () => {
    const db = makeTestDb();
    const dataDir = tempDataDir();
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
      dataDir,
    });
    const { runId } = await watcher.handleRunRequested(taskId);
    const fullAnswer = richFinalAnswer();
    const worklabResult = {
      schema: "worklab.v2",
      stage: "execute",
      decision: "advance",
      summary: "Restaurant research complete",
      details: "Iharada is the top pick.",
      final_text: "Research complete. Iharada is the top pick.",
      artifacts: {},
      blocking_issues: [],
      pending_actions: [],
      subtasks: [],
    };
    resolveDone({
      exitCode: 0,
      status: "complete",
      processStatus: "succeeded",
      finalText: `${fullAnswer}\n\n\`\`\`json\n${JSON.stringify(worklabResult)}\n\`\`\``,
      worklabResult,
      events: kbWriteEvents({ slug: "restaurant-research", isError: true }),
    });
    await new Promise((r) => setTimeout(r, 20));

    const slug = slugify(`run-${runId}`, "run-result");
    expect(kbRead({ dataDir, slug })?.body).toContain("# Complete Restaurant Research");
    const agentComment = db
      .prepare("SELECT body FROM task_comments WHERE task_id = ? AND author_type = 'agent'")
      .get(taskId);
    expect(agentComment.body).toBe(`Research complete. Iharada is the top pick.\n\nFull final answer: [Knowledge entry](#/knowledge/${slug})`);
  });

  it("does not create knowledge entries for short final comments", async () => {
    const db = makeTestDb();
    const dataDir = tempDataDir();
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
      dataDir,
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
    expect(kbList({ dataDir })).toEqual([]);
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

  it("stores markdown plan output while posting the structured final_text comment", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    const taskId = seedTask(db, { owner: "coder", stage: "plan" });
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
      stage: "plan",
      decision: "advance",
      summary: "Plan ready",
      details: "Compressed planning metadata.",
      final_text: "Plan ready. Moving to execute.",
      artifacts: {},
      blocking_issues: [],
      pending_actions: [],
      subtasks: [],
    };
    const plan = "## Plan\n\n1. Read inputs.\n2. Write output.\n\n**Test Plan**\n\nRun focused tests.";
    resolveDone({
      exitCode: 0,
      status: "complete",
      processStatus: "succeeded",
      finalText: `${plan}\n\n\`\`\`json\n${JSON.stringify(worklabResult)}\n\`\`\``,
      worklabResult,
    });
    await new Promise((r) => setTimeout(r, 20));
    const task = db.prepare("SELECT stage, plan_body FROM tasks WHERE id = ?").get(taskId);
    expect(task.stage).toBe("execute");
    expect(task.plan_body).toBe(plan);
    const agentComment = db
      .prepare("SELECT body FROM task_comments WHERE task_id = ? AND author_type = 'agent'")
      .get(taskId);
    expect(agentComment.body).toBe("Plan ready. Moving to execute.");
  });

  it("prefers structured plan details over human-facing final prose", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    const taskId = seedTask(db, { owner: "coder", stage: "plan" });
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
    const plan = "## Plan: Research Kaiseki Restaurant\n\n### Steps\n1. Verify candidates.\n2. Rank options.\n\n### Risks\n- Availability may be limited.";
    const worklabResult = {
      schema: "worklab.v2",
      stage: "plan",
      decision: "advance",
      summary: "Plan ready",
      details: plan,
      final_text: "Plan is ready. Execution will clarify the restaurant name and research bookable options.",
      artifacts: {},
      blocking_issues: [],
      pending_actions: [],
      subtasks: [],
    };
    const prose = `Based on my research, I identified a key ambiguity. Here is the structured result:

\`\`\`json
${JSON.stringify(worklabResult)}
\`\`\`

---

**Plan summary for you:**

Before execution, I flagged that no exact restaurant match was found.

1. Confirm the kaiseki interpretation.
2. Build and filter candidate restaurants.
3. Rank options with booking guidance.

The main risks are budget, booking window, and unknown group size.`;
    resolveDone({
      exitCode: 0,
      status: "complete",
      processStatus: "succeeded",
      finalText: prose,
      worklabResult,
    });
    await new Promise((r) => setTimeout(r, 20));
    const task = db.prepare("SELECT stage, plan_body FROM tasks WHERE id = ?").get(taskId);
    expect(task.stage).toBe("execute");
    expect(task.plan_body).toBe(plan);
    const agentComment = db
      .prepare("SELECT body FROM task_comments WHERE task_id = ? AND author_type = 'agent'")
      .get(taskId);
    expect(agentComment.body).toBe(worklabResult.final_text);
  });

  it("falls back to structured plan details when final text is only structured JSON", async () => {
    const db = makeTestDb();
    seedAgent(db, "coder");
    const taskId = seedTask(db, { owner: "coder", stage: "plan" });
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
      stage: "plan",
      decision: "advance",
      summary: "Plan ready",
      details: "## Plan\n\n1. Build it.",
      final_text: "Plan ready. Moving to execute.",
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
    const task = db.prepare("SELECT plan_body FROM tasks WHERE id = ?").get(taskId);
    expect(task.plan_body).toBe("## Plan\n\n1. Build it.");
    const agentComment = db
      .prepare("SELECT body FROM task_comments WHERE task_id = ? AND author_type = 'agent'")
      .get(taskId);
    expect(agentComment.body).toBe("Plan ready. Moving to execute.");
  });
});
