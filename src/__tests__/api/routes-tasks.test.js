import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestServer } from "../helpers/test-server.js";

async function withPreviewServer(fn) {
  const dataDir = mkdtempSync(join(tmpdir(), "worklab-run-preview-"));
  const server = makeTestServer({
    dataDir,
    config: { dataDir, repoRoot: process.cwd(), workspace: process.cwd() },
  });
  try {
    return await fn(server);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

function seedAgent(db, name, patch = {}) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO agents
      (name, display_name, sdk, model, effort, instructions, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name,
    patch.displayName || name,
    patch.sdk || "claude",
    patch.model || "claude:claude-sonnet-4-6",
    patch.effort || "medium",
    patch.instructions || `Instructions for ${name}`,
    now,
    now,
  );
}

describe("GET /api/tasks", () => {
  it("returns empty list initially", async () => {
    const { agent } = makeTestServer();
    const res = await agent.get("/api/tasks").expect(200);
    expect(res.body).toEqual({ tasks: [] });
  });
});

describe("GET /api/runs/cost-summary", () => {
  it("summarizes daily, weekly, and per-agent run costs", async () => {
    const { agent, db } = makeTestServer();
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "costed" }).expect(201);
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const today = todayStart.getTime() + 1_000;
    const yesterday = todayStart.getTime() - 24 * 60 * 60 * 1000;
    const older = todayStart.getTime() - 8 * 24 * 60 * 60 * 1000;
    const insertRun = db.prepare(`
      INSERT INTO task_runs (id, task_id, mode, agent_name, started_at, status, cost_usd)
      VALUES (?, ?, 'execute', ?, ?, 'complete', ?)
    `);
    insertRun.run("today-alpha", task.id, "alpha", today, 0.01);
    insertRun.run("today-beta", task.id, "beta", today + 1, 0.02);
    insertRun.run("week-alpha", task.id, "alpha", yesterday, 0.03);
    insertRun.run("old-alpha", task.id, "alpha", older, 0.99);
    insertRun.run("uncosted", task.id, "beta", today + 2, null);

    const res = await agent.get("/api/runs/cost-summary").expect(200);

    expect(res.body.today.run_count).toBe(2);
    expect(res.body.today.total_usd).toBeCloseTo(0.03);
    expect(res.body.week.run_count).toBe(3);
    expect(res.body.week.total_usd).toBeCloseTo(0.06);
    expect(res.body.today_by_agent).toEqual([
      { agent: "beta", total_usd: 0.02, run_count: 1 },
      { agent: "alpha", total_usd: 0.01, run_count: 1 },
    ]);
  });
});

describe("POST /api/tasks", () => {
  it("creates a task with required fields", async () => {
    const { agent } = makeTestServer();
    const res = await agent.post("/api/tasks").send({ title: "do thing" }).expect(201);
    expect(res.body.task.id).toMatch(/^[a-zA-Z0-9]{21}$/);
    expect(res.body.task.task_key).toBe("T-1");
    expect(res.body.task.title).toBe("do thing");
    expect(res.body.task.status).toBeUndefined();
    expect(res.body.task.stage).toBe("plan");
    expect(res.body.task.run_policy).toBe("auto_plan_execute");
    expect(res.body.task.root_task_id).toBe(res.body.task.id);
    expect(res.body.task.planner_agent).toBeNull();
    expect(res.body.task.plan_body).toBe("");
    expect(res.body.task.plan_updated_at).toBeNull();
    expect(res.body.task.plan_updated_by).toBeNull();
    expect(res.body.task.plan_source_run_id).toBeNull();
    expect(res.body.task.priority).toBeUndefined();
  });

  it("rejects missing title", async () => {
    const { agent } = makeTestServer();
    await agent.post("/api/tasks").send({}).expect(400);
  });

  it("rejects legacy status and executor fields", async () => {
    const { agent } = makeTestServer();
    await agent.post("/api/tasks").send({ title: "old", status: "todo" }).expect(400);
    await agent.post("/api/tasks").send({ title: "old", executor_agent: "coder" }).expect(400);
  });

  it("returns new task in GET list", async () => {
    const { agent } = makeTestServer();
    await agent.post("/api/tasks").send({ title: "a" });
    await agent.post("/api/tasks").send({ title: "b" });
    const res = await agent.get("/api/tasks").expect(200);
    expect(res.body.tasks.map(t => t.title).sort()).toEqual(["a", "b"]);
    expect(res.body.tasks.map(t => t.task_key).sort()).toEqual(["T-1", "T-2"]);
  });

  it("deduplicates create retries with the same client request id", async () => {
    const { agent, db } = makeTestServer();
    const body = { title: "a", client_request_id: "create-once" };

    const first = await agent.post("/api/tasks").send(body).expect(201);
    const second = await agent.post("/api/tasks").send(body).expect(200);

    expect(second.body.task.id).toBe(first.body.task.id);
    expect(db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE client_request_id = ?").get("create-once").c).toBe(1);
  });

  it("stores dependency ids and exposes compact blockers", async () => {
    const { agent } = makeTestServer();
    const { body: { task: blocker } } = await agent.post("/api/tasks").send({ title: "Blocker" }).expect(201);
    const { body: { task } } = await agent.post("/api/tasks").send({
      title: "Blocked task",
      blocked_by_ids: [blocker.task_key],
    }).expect(201);
    expect(task.dependency_ids).toEqual([blocker.id]);
    expect(task.blocked_by).toHaveLength(1);
    expect(task.blocked_by[0]).toMatchObject({ id: blocker.id, task_key: blocker.task_key, title: "Blocker" });
  });

  it("resolves task routes by public task key", async () => {
    const calls = [];
    const { agent } = makeTestServer({
      watcher: {
        handleRunRequested: async (taskId) => { calls.push(taskId); return { runId: "fake-run" }; },
        cancel: () => true,
        shutdown: async () => {},
        isActive: () => false,
        maybeAutoStart: () => {},
        maybeAutoStartDependents: () => {},
      },
    });
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "keyed" }).expect(201);

    const detail = await agent.get(`/api/tasks/${task.task_key}`).expect(200);
    expect(detail.body.task.id).toBe(task.id);
    await agent.patch(`/api/tasks/${task.task_key}`).send({ title: "renamed" }).expect(200);
    await agent.post(`/api/tasks/${task.task_key}/comments`).send({ body: "note" }).expect(201);
    await agent.get(`/api/tasks/${task.task_key}/runs`).expect(200);
    await agent.post(`/api/tasks/${task.task_key}/run`).expect(200);
    await agent.post(`/api/tasks/${task.task_key}/cancel`).expect(204);

    expect(calls).toEqual([task.id]);
  });

  it("broadcasts task_created", async () => {
    const { agent, broker } = makeTestServer();
    let captured = null;
    broker.broadcast = (ch, p) => { if (ch === "global") captured = p; };
    await agent.post("/api/tasks").send({ title: "watch me" });
    expect(captured).toMatchObject({ type: "task_created" });
  });
});

describe("GET /api/tasks/:id", () => {
  it("returns 404 for missing task", async () => {
    const { agent } = makeTestServer();
    await agent.get("/api/tasks/nope").expect(404);
  });

  it("returns task with comments and runs arrays", async () => {
    const { agent } = makeTestServer();
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    const res = await agent.get(`/api/tasks/${task.id}`).expect(200);
    expect(res.body.task.id).toBe(task.id);
    expect(res.body.comments).toEqual([]);
    expect(res.body.runs).toEqual([]);
  });

  it("enriches agent comment attribution with the agent display name", async () => {
    const { agent, db } = makeTestServer();
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    const now = Date.now();
    db.prepare("INSERT INTO agents (name, display_name, sdk, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("code-reviewer", "Code Reviewer", "claude", "claude:claude-sonnet-4-6", now, now);
    db.prepare("INSERT INTO task_comments (id, task_id, author_type, author_id, body, created_at) VALUES (?, ?, 'agent', ?, ?, ?)")
      .run("comment-agent", task.id, "code-reviewer", "looks good", now);

    const res = await agent.get(`/api/tasks/${task.id}`).expect(200);

    expect(res.body.comments[0]).toMatchObject({
      author_type: "agent",
      author_id: "code-reviewer",
      author: {
        type: "agent",
        id: "code-reviewer",
        display_name: "Code Reviewer",
      },
    });
  });

  it("includes blockers and reverse links in task detail", async () => {
    const { agent } = makeTestServer();
    const { body: { task: blocker } } = await agent.post("/api/tasks").send({ title: "Blocker" }).expect(201);
    const { body: { task: blocked } } = await agent.post("/api/tasks").send({
      title: "Blocked task",
      blocked_by_ids: [blocker.id],
    }).expect(201);

    const blockerDetail = await agent.get(`/api/tasks/${blocker.id}`).expect(200);
    const blockedDetail = await agent.get(`/api/tasks/${blocked.id}`).expect(200);

    expect(blockedDetail.body.task.dependency_ids).toEqual([blocker.id]);
    expect(blockedDetail.body.task.blocked_by[0]).toMatchObject({ id: blocker.id, title: "Blocker" });
    expect(blockerDetail.body.task.blocks[0]).toMatchObject({ id: blocked.id, title: "Blocked task" });
  });

  it("orders runs newest first when timestamps match", async () => {
    const { agent, db } = makeTestServer();
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    db.prepare(
      "INSERT INTO task_runs (id, task_id, mode, agent_name, started_at, status) VALUES (?, ?, 'execute', 'alpha', ?, 'complete')",
    ).run("run-old", task.id, 1234);
    db.prepare(
      "INSERT INTO task_runs (id, task_id, mode, agent_name, started_at, status) VALUES (?, ?, 'execute', 'alpha', ?, 'running')",
    ).run("run-new", task.id, 1234);

    const res = await agent.get(`/api/tasks/${task.id}`).expect(200);

    expect(res.body.runs.map((run) => run.id)).toEqual(["run-new", "run-old"]);
  });

  it("includes live input state on task detail runs", async () => {
    const watcher = {
      handleRunRequested: async () => ({ runId: "fake-run" }),
      cancel: () => true,
      shutdown: async () => {},
      isActive: () => true,
      isRunActive: () => true,
      getRunLiveInputState: (runId) => (
        runId === "run-active"
          ? { supported: true, active: true, reason: null }
          : { supported: false, active: false, reason: "not_active" }
      ),
      sendRunMessage: async () => ({ ok: true }),
      maybeAutoStart: () => {},
      maybeAutoStartDependents: () => {},
    };
    const { agent, db } = makeTestServer({ watcher });
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    db.prepare(
      `INSERT INTO task_runs
        (id, task_id, mode, agent_name, provider_kind, started_at, status, process_status)
       VALUES (?, ?, 'execute', 'alpha', 'codex', ?, 'running', 'running')`,
    ).run("run-active", task.id, Date.now());

    const res = await agent.get(`/api/tasks/${task.id}`).expect(200);

    expect(res.body.runs[0].live_input).toEqual({
      supported: true,
      active: true,
      reason: null,
    });
  });

  it("includes the latest running event summary on list and detail payloads", async () => {
    const { agent, db } = makeTestServer();
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    const now = Date.now();
    db.prepare(
      "INSERT INTO task_runs (id, task_id, mode, agent_name, started_at, status, process_status) VALUES (?, ?, 'execute', 'alpha', ?, 'running', 'running')",
    ).run("run-active", task.id, now);
    db.prepare("INSERT INTO agent_logs (id, task_run_id, events, status, created_at) VALUES (?, ?, ?, 'running', ?)")
      .run("log-active", "run-active", JSON.stringify([
        { type: "text", text: "first", _event_seq: 1 },
        { type: "text", text: "latest", _event_seq: 2 },
      ]), now);

    const list = await agent.get("/api/tasks").expect(200);
    const detail = await agent.get(`/api/tasks/${task.id}`).expect(200);

    expect(list.body.tasks[0].running_run).toMatchObject({
      id: "run-active",
      event_count: 2,
      last_event: { type: "text", text: "latest", _event_seq: 2 },
    });
    expect(detail.body.task.running_run.last_event.text).toBe("latest");
  });

  it("embeds compact run log metadata for task detail summaries", async () => {
    const { agent, db } = makeTestServer();
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    db.prepare(
      "INSERT INTO task_runs (id, task_id, mode, agent_name, started_at, ended_at, status, exit_code) VALUES (?, ?, 'execute', 'alpha', ?, ?, 'complete', 0)",
    ).run("run-with-log", task.id, 1000, 2500);
    db.prepare(`
      INSERT INTO agent_logs
        (id, task_run_id, events, model, effort, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, duration_ms, num_turns, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "log-1",
      "run-with-log",
      JSON.stringify([{ type: "final", text: "done" }]),
      "model-a",
      "medium",
      123,
      45,
      6,
      7,
      0.0123,
      1500,
      2,
      "complete",
      2500,
    );

    const res = await agent.get(`/api/tasks/${task.id}`).expect(200);

    expect(res.body.runs[0].log).toMatchObject({
      id: "log-1",
      model: "model-a",
      effort: "medium",
      input_tokens: 123,
      output_tokens: 45,
      cache_read_tokens: 6,
      cache_creation_tokens: 7,
      cost_usd: 0.0123,
      duration_ms: 1500,
      num_turns: 2,
      status: "complete",
    });
  });
});

describe("PATCH /api/tasks/:id", () => {
  it("updates title and instructions", async () => {
    const { agent } = makeTestServer();
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "orig" });
    const res = await agent.patch(`/api/tasks/${task.id}`).send({ title: "new", instructions: "do this" });
    expect(res.body.task.title).toBe("new");
    expect(res.body.task.instructions).toBe("do this");
  });

  it("updates editable plan text and records human metadata", async () => {
    const { agent } = makeTestServer();
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "orig" });
    const res = await agent.patch(`/api/tasks/${task.id}`).send({ plan_body: "## Plan\n\nDo the thing." }).expect(200);
    expect(res.body.task.plan_body).toBe("## Plan\n\nDo the thing.");
    expect(res.body.task.plan_updated_at).toBeTruthy();
    expect(res.body.task.plan_updated_by).toBe("human");
    expect(res.body.task.plan_source_run_id).toBeNull();
  });

  it("PATCH broadcasts task_updated", async () => {
    const { agent, broker } = makeTestServer();
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "a" });
    let got = null;
    broker.broadcast = (ch, p) => { if (ch === "global" && p.type === "task_updated") got = p; };
    await agent.patch(`/api/tasks/${task.id}`).send({ title: "b" });
    expect(got).toEqual({ type: "task_updated", id: task.id, taskKey: task.task_key });
  });

  it("stores owner and planner assignments", async () => {
    const { agent, db } = makeTestServer();
    const now = Date.now();
    db.prepare(`INSERT INTO agents (name, display_name, sdk, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("coder", "Coder", "claude", "claude:claude-sonnet-4-6", now, now);
    db.prepare(`INSERT INTO agents (name, display_name, sdk, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("planner", "Planner", "claude", "claude:claude-sonnet-4-6", now, now);
    const { body: { task } } = await agent.post("/api/tasks").send({
      title: "owned",
      owner_agent: "coder",
      planner_agent: "planner",
    }).expect(201);
    expect(task.owner_agent).toBe("coder");
    expect(task.planner_agent).toBe("planner");
    expect(task.executor_agent).toBeUndefined();

    const res = await agent.patch(`/api/tasks/${task.id}`).send({ owner_agent: null, planner_agent: null }).expect(200);
    expect(res.body.task.owner_agent).toBeNull();
    expect(res.body.task.planner_agent).toBeNull();
    expect(res.body.task.executor_agent).toBeUndefined();
  });

  it("updates run policy and rejects invalid values", async () => {
    const { agent } = makeTestServer();
    const { body: { task } } = await agent.post("/api/tasks").send({
      title: "auto",
      run_policy: "auto_plan_execute",
    }).expect(201);
    expect(task.run_policy).toBe("auto_plan_execute");

    const manual = await agent.patch(`/api/tasks/${task.id}`).send({ run_policy: "manual" }).expect(200);
    expect(manual.body.task.run_policy).toBe("manual");
    await agent.patch(`/api/tasks/${task.id}`).send({ run_policy: "always" }).expect(400);
  });

  it("rejects legacy status and executor fields", async () => {
    const { agent } = makeTestServer();
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    await agent.patch(`/api/tasks/${task.id}`).send({ status: "done" }).expect(400);
    await agent.patch(`/api/tasks/${task.id}`).send({ executor_agent: "coder" }).expect(400);
  });

  it("rejects dependency cycles", async () => {
    const { agent } = makeTestServer();
    const { body: { task: a } } = await agent.post("/api/tasks").send({ title: "A" }).expect(201);
    const { body: { task: b } } = await agent.post("/api/tasks").send({
      title: "B",
      blocked_by_ids: [a.id],
    }).expect(201);

    await agent.patch(`/api/tasks/${a.id}`).send({ blocked_by_ids: [b.id] }).expect(400);
  });
});

describe("PATCH /api/tasks/:id stage", () => {
  it("human_move changes workflow stage without faking an active worker", async () => {
    const { agent } = makeTestServer();
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    const res = await agent.patch(`/api/tasks/${task.id}`).send({ stage: "review" });
    expect(res.body.task.stage).toBe("review");
    expect(res.body.task.status).toBeUndefined();
    expect(res.body.task.running_run_id).toBeNull();
  });

  it("invalid stage value returns 400", async () => {
    const { agent } = makeTestServer();
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    await agent.patch(`/api/tasks/${task.id}`).send({ stage: "bogus" }).expect(400);
  });

  it("setting stage=done sets completed_at", async () => {
    const { agent } = makeTestServer();
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    await agent.patch(`/api/tasks/${task.id}`).send({ stage: "review" });
    const res = await agent.patch(`/api/tasks/${task.id}`).send({ stage: "done" });
    expect(res.body.task.completed_at).toBeTruthy();
  });

  it("notifies the watcher to wake dependents when a task is marked done", async () => {
    const watcher = {
      handleRunRequested: async () => ({ runId: "fake-run" }),
      cancel: () => true,
      shutdown: async () => {},
      isActive: () => false,
      maybeAutoStart: vi.fn(),
      maybeAutoStartDependents: vi.fn(),
    };
    const { agent } = makeTestServer({ watcher });
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });

    await agent.patch(`/api/tasks/${task.id}`).send({ stage: "done" }).expect(200);

    expect(watcher.maybeAutoStartDependents).toHaveBeenCalledWith(task.id);
  });

  it("moving done → execute clears completed_at", async () => {
    const { agent } = makeTestServer();
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    await agent.patch(`/api/tasks/${task.id}`).send({ stage: "done" });
    const res = await agent.patch(`/api/tasks/${task.id}`).send({ stage: "execute" });
    expect(res.body.task.completed_at).toBeNull();
  });
});

describe("POST /api/tasks/bulk", () => {
  it("bulk patches owner, planner, reviewer, and run policy", async () => {
    const { agent, db } = makeTestServer();
    const now = Date.now();
    db.prepare(`INSERT INTO agents (name, display_name, sdk, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("owner", "Owner", "claude", "claude:claude-sonnet-4-6", now, now);
    db.prepare(`INSERT INTO agents (name, display_name, sdk, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("planner", "Planner", "claude", "claude:claude-sonnet-4-6", now, now);
    db.prepare(`INSERT INTO agents (name, display_name, sdk, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("reviewer", "Reviewer", "claude", "claude:claude-sonnet-4-6", now, now);
    const { body: { task: a } } = await agent.post("/api/tasks").send({ title: "a" }).expect(201);
    const { body: { task: b } } = await agent.post("/api/tasks").send({ title: "b" }).expect(201);

    const res = await agent.post("/api/tasks/bulk").send({
      ids: [a.task_key, b.task_key],
      operation: "patch",
      patch: {
        owner_agent: "owner",
        planner_agent: "planner",
        reviewer_agent: "reviewer",
        run_policy: "auto_plan_execute",
      },
    }).expect(200);

    expect(res.body.summary).toEqual({ requested: 2, succeeded: 2, failed: 0 });
    expect(res.body.results.map((result) => result.task_id).sort()).toEqual([a.id, b.id].sort());
    expect(res.body.results.every((result) => result.ok)).toBe(true);
    const rows = db.prepare("SELECT owner_agent, planner_agent, reviewer_agent, run_policy FROM tasks ORDER BY title").all();
    expect(rows).toEqual([
      { owner_agent: "owner", planner_agent: "planner", reviewer_agent: "reviewer", run_policy: "auto_plan_execute" },
      { owner_agent: "owner", planner_agent: "planner", reviewer_agent: "reviewer", run_policy: "auto_plan_execute" },
    ]);
  });

  it("bulk patch reports per-task failures while updating valid tasks", async () => {
    const { agent, db } = makeTestServer();
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "a" }).expect(201);

    const res = await agent.post("/api/tasks/bulk").send({
      ids: [task.id, "missing"],
      operation: "patch",
      patch: { stage: "execute" },
    }).expect(200);

    expect(res.body.summary).toEqual({ requested: 2, succeeded: 1, failed: 1 });
    expect(res.body.results.find((result) => result.id === task.id)).toMatchObject({ ok: true });
    expect(res.body.results.find((result) => result.id === "missing").error.code).toBe("not_found");
    expect(db.prepare("SELECT stage FROM tasks WHERE id = ?").get(task.id).stage).toBe("execute");
  });

  it("bulk delete removes deletable tasks and rejects running tasks per item", async () => {
    const { agent, db } = makeTestServer();
    const { body: { task: deletable } } = await agent.post("/api/tasks").send({ title: "delete" }).expect(201);
    const { body: { task: running } } = await agent.post("/api/tasks").send({ title: "running" }).expect(201);
    db.prepare(
      "INSERT INTO task_runs (id, task_id, mode, stage, agent_name, started_at, status, process_status) VALUES (?, ?, 'execute', 'execute', 'alpha', ?, 'running', 'running')",
    ).run("active-run", running.id, Date.now());

    const res = await agent.post("/api/tasks/bulk").send({
      ids: [deletable.id, running.id],
      operation: "delete",
    }).expect(200);

    expect(res.body.summary).toEqual({ requested: 2, succeeded: 1, failed: 1 });
    expect(res.body.results.find((result) => result.id === running.id).error.code).toBe("task_running");
    expect(db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE id = ?").get(deletable.id).c).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE id = ?").get(running.id).c).toBe(1);
  });

  it("rejects invalid bulk requests", async () => {
    const { agent } = makeTestServer();
    await agent.post("/api/tasks/bulk").send({ ids: [], operation: "delete" }).expect(400);
    await agent.post("/api/tasks/bulk").send({ ids: ["a"], operation: "bogus" }).expect(400);
    await agent.post("/api/tasks/bulk").send({ ids: ["a"], operation: "patch", patch: { stage: "bogus" } }).expect(400);
    await agent.post("/api/tasks/bulk").send({ ids: ["a"], operation: "patch", patch: { title: "unsupported" } }).expect(400);
  });
});

describe("POST /api/tasks/:id/subtasks", () => {
  it("creates a manual required subtask in plan and moves parent to awaiting_children", async () => {
    const { agent, db } = makeTestServer();
    const now = Date.now();
    db.prepare(`INSERT INTO agents (name, display_name, sdk, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("owner", "Owner", "claude", "claude:claude-sonnet-4-6", now, now);
    db.prepare(`INSERT INTO agents (name, display_name, sdk, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("planner", "Planner", "claude", "claude:claude-sonnet-4-6", now, now);
    const { body: { task: parent } } = await agent.post("/api/tasks").send({
      title: "Parent",
      owner_agent: "owner",
      planner_agent: "planner",
    }).expect(201);

    const res = await agent.post(`/api/tasks/${parent.task_key}/subtasks`).send({ title: "Child" }).expect(201);

    expect(res.body.task).toMatchObject({
      task_key: "T-2",
      title: "Child",
      parent_task_id: parent.id,
      root_task_id: parent.id,
      owner_agent: "owner",
      planner_agent: "planner",
      stage: "plan",
      run_policy: "auto_plan_execute",
      required: true,
    });
    expect(res.body.parent).toMatchObject({ id: parent.id, stage: "awaiting_children", stage_reason: "waiting for manual subtasks" });
    const edge = db.prepare("SELECT required, created_by_run_id FROM task_edges WHERE parent_task_id = ? AND child_task_id = ?").get(parent.id, res.body.task.id);
    expect(edge).toMatchObject({ required: 1, created_by_run_id: null });
  });

  it("optional manual subtasks do not make the parent wait", async () => {
    const { agent } = makeTestServer();
    const { body: { task: parent } } = await agent.post("/api/tasks").send({ title: "Parent", stage: "execute" }).expect(201);

    const res = await agent.post(`/api/tasks/${parent.id}/subtasks`).send({ title: "Optional", required: false }).expect(201);

    expect(res.body.task.required).toBe(false);
    expect(res.body.parent.stage).toBe("execute");
  });

  it("human finishing a required child resumes the waiting parent", async () => {
    const { agent, db } = makeTestServer();
    const { body: { task: parent } } = await agent.post("/api/tasks").send({ title: "Parent", stage: "execute" }).expect(201);
    const { body: { task: child } } = await agent.post(`/api/tasks/${parent.id}/subtasks`).send({ title: "Child" }).expect(201);

    await agent.patch(`/api/tasks/${child.id}`).send({ stage: "done" }).expect(200);

    const parentRow = db.prepare("SELECT stage, stage_reason FROM tasks WHERE id = ?").get(parent.id);
    expect(parentRow).toMatchObject({ stage: "execute", stage_reason: "required children completed" });
  });

  it("required child finishing resumes the parent even when an optional sibling is still in progress", async () => {
    const { agent, db } = makeTestServer();
    const { body: { task: parent } } = await agent.post("/api/tasks").send({ title: "Parent", stage: "execute" }).expect(201);
    const { body: { task: required } } = await agent.post(`/api/tasks/${parent.id}/subtasks`).send({ title: "Required" }).expect(201);
    const { body: { task: optional } } = await agent.post(`/api/tasks/${parent.id}/subtasks`).send({ title: "Optional", required: false }).expect(201);

    // Sanity: parent is awaiting children after the required subtask was added.
    expect(db.prepare("SELECT stage FROM tasks WHERE id = ?").get(parent.id).stage).toBe("awaiting_children");
    expect(db.prepare("SELECT stage FROM tasks WHERE id = ?").get(optional.id).stage).toBe("plan");

    // Finish only the required child; optional child is left in plan.
    await agent.patch(`/api/tasks/${required.id}`).send({ stage: "done" }).expect(200);

    const parentRow = db.prepare("SELECT stage, stage_reason FROM tasks WHERE id = ?").get(parent.id);
    expect(parentRow.stage).toBe("execute");
    expect(parentRow.stage_reason).toBe("required children completed");
    // Optional child untouched.
    expect(db.prepare("SELECT stage FROM tasks WHERE id = ?").get(optional.id).stage).toBe("plan");
  });

  it("human blocking a required child blocks the waiting parent", async () => {
    const { agent, db } = makeTestServer();
    const { body: { task: parent } } = await agent.post("/api/tasks").send({ title: "Parent", stage: "execute" }).expect(201);
    const { body: { task: child } } = await agent.post(`/api/tasks/${parent.id}/subtasks`).send({ title: "Child" }).expect(201);

    await agent.patch(`/api/tasks/${child.id}`).send({ stage: "blocked" }).expect(200);

    const parentRow = db.prepare("SELECT stage, error_text, stage_reason, blocking_issues_json FROM tasks WHERE id = ?").get(parent.id);
    expect(parentRow.stage).toBe("blocked");
    expect(parentRow.error_text).toBe("Required child blocked: Child");
    expect(parentRow.stage_reason).toBe("required_child_blocked");
    expect(JSON.parse(parentRow.blocking_issues_json)).toEqual(["Required child blocked: Child"]);
  });
});

describe("DELETE /api/tasks/:id", () => {
  it("removes task and cascades comments", async () => {
    const { agent, db } = makeTestServer();
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    await agent.post(`/api/tasks/${task.id}/comments`).send({ body: "hi" }).expect(201);
    await agent.delete(`/api/tasks/${task.id}`).expect(204);
    expect(db.prepare("SELECT COUNT(*) AS c FROM tasks").get().c).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS c FROM task_comments").get().c).toBe(0);
  });

  it("returns 404 for missing", async () => {
    const { agent } = makeTestServer();
    await agent.delete("/api/tasks/missing").expect(404);
  });

  it("rejects deleting a task with a running run", async () => {
    const { agent, db } = makeTestServer();
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    db.prepare(
      "INSERT INTO task_runs (id, task_id, mode, stage, agent_name, started_at, status, process_status) VALUES (?, ?, 'execute', 'execute', 'alpha', ?, 'running', 'running')",
    ).run("active-run", task.id, Date.now());
    const res = await agent.delete(`/api/tasks/${task.id}`).expect(409);
    expect(res.body.error.code).toBe("task_running");
  });
});

describe("POST /api/tasks/:id/comments", () => {
  function watcherWithRun(overrides = {}) {
    return {
      handleRunRequested: vi.fn(async () => ({ runId: "r1" })),
      cancel: () => true,
      shutdown: async () => {},
      isActive: () => false,
      ...overrides,
    };
  }

  it("creates a human comment", async () => {
    const { agent } = makeTestServer();
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    const res = await agent.post(`/api/tasks/${task.id}/comments`).send({ body: "a note" }).expect(201);
    expect(res.body.comment.body).toBe("a note");
    expect(res.body.comment.author_type).toBe("human");
  });

  it("does not rerun by default", async () => {
    const watcher = watcherWithRun();
    const { agent } = makeTestServer({ watcher });
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    const res = await agent.post(`/api/tasks/${task.id}/comments`).send({ body: "a note" }).expect(201);
    expect(res.body.rerun).toBeUndefined();
    expect(watcher.handleRunRequested).not.toHaveBeenCalled();
  });

  it("does not rerun when explicitly unchecked", async () => {
    const watcher = watcherWithRun();
    const { agent } = makeTestServer({ watcher });
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    const res = await agent.post(`/api/tasks/${task.id}/comments`).send({ body: "a note", rerun: false }).expect(201);
    expect(res.body.rerun).toBeUndefined();
    expect(watcher.handleRunRequested).not.toHaveBeenCalled();
  });

  it("reruns an execute task when requested", async () => {
    const watcher = watcherWithRun();
    const { agent } = makeTestServer({ watcher });
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    await agent.patch(`/api/tasks/${task.id}`).send({ stage: "execute" }).expect(200);
    const res = await agent.post(`/api/tasks/${task.id}/comments`).send({ body: "try again", rerun: true }).expect(201);
    expect(res.body.comment.body).toBe("try again");
    expect(res.body.rerun).toEqual({ requested: true, started: true, runId: "r1" });
    expect(watcher.handleRunRequested).toHaveBeenCalledWith(task.id);
  });

  it("reopens done tasks to execute before rerunning", async () => {
    const watcher = watcherWithRun();
    const { agent, db } = makeTestServer({ watcher });
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    await agent.patch(`/api/tasks/${task.id}`).send({ stage: "done" }).expect(200);
    expect(db.prepare("SELECT completed_at FROM tasks WHERE id = ?").get(task.id).completed_at).toBeTruthy();

    const res = await agent.post(`/api/tasks/${task.id}/comments`).send({ body: "redo this", rerun: true }).expect(201);

    expect(res.body.rerun).toEqual({ requested: true, started: true, runId: "r1" });
    const updated = db.prepare("SELECT stage, completed_at FROM tasks WHERE id = ?").get(task.id);
    expect(updated.stage).toBe("execute");
    expect(updated.completed_at).toBeNull();
    expect(watcher.handleRunRequested).toHaveBeenCalledWith(task.id);
  });

  it("keeps the comment when the requested rerun fails", async () => {
    const watcher = watcherWithRun({
      handleRunRequested: vi.fn(async () => {
        throw Object.assign(new Error("no owner assigned"), { code: "missing_agent" });
      }),
    });
    const { agent, db } = makeTestServer({ watcher });
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    const res = await agent.post(`/api/tasks/${task.id}/comments`).send({ body: "please continue", rerun: true }).expect(201);

    expect(res.body.comment.body).toBe("please continue");
    expect(res.body.rerun).toEqual({
      requested: true,
      started: false,
      error: { code: "missing_agent", message: "no owner assigned" },
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM task_comments WHERE task_id = ?").get(task.id).count).toBe(1);
  });

  it("keeps the comment when a task is already running", async () => {
    const watcher = watcherWithRun({ isActive: () => true });
    const { agent } = makeTestServer({ watcher });
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    const res = await agent.post(`/api/tasks/${task.id}/comments`).send({ body: "note while running", rerun: true }).expect(201);
    expect(res.body.rerun).toEqual({
      requested: true,
      started: false,
      error: { code: "already_running", message: "task already running" },
    });
    expect(watcher.handleRunRequested).not.toHaveBeenCalled();
  });

  it("rejects empty body", async () => {
    const { agent } = makeTestServer();
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    await agent.post(`/api/tasks/${task.id}/comments`).send({}).expect(400);
  });

  it("broadcasts task_updated", async () => {
    const { agent, broker } = makeTestServer();
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    const events = [];
    broker.broadcast = (ch, p) => { if (ch === "global") events.push(p); };
    await agent.post(`/api/tasks/${task.id}/comments`).send({ body: "x" });
    expect(events.some(e => e.type === "task_updated")).toBe(true);
  });
});

describe("DELETE /api/tasks/:id/comments/:commentId", () => {
  it("deletes a human comment by task key, broadcasts, and removes it from future run prompts", async () => {
    await withPreviewServer(async ({ agent, db, broker }) => {
      seedAgent(db, "planner", { instructions: "Plan carefully." });
      const { body: { task } } = await agent.post("/api/tasks").send({
        title: "Preview task",
        stage: "plan",
        owner_agent: "planner",
      }).expect(201);
      const { body: { comment } } = await agent.post(`/api/tasks/${task.id}/comments`)
        .send({ body: "Remove this obsolete guidance." })
        .expect(201);
      const before = await agent.get(`/api/tasks/${task.id}/run-preview`).expect(200);
      expect(before.body.preview.system_prompt).toContain("Remove this obsolete guidance.");

      const events = [];
      broker.broadcast = (ch, p) => { if (ch === "global") events.push(p); };

      await agent.delete(`/api/tasks/${task.task_key}/comments/${comment.id}`).expect(204);

      expect(db.prepare("SELECT COUNT(*) AS count FROM task_comments WHERE id = ?").get(comment.id).count).toBe(0);
      const detail = await agent.get(`/api/tasks/${task.id}`).expect(200);
      expect(detail.body.comments.map((row) => row.id)).not.toContain(comment.id);
      expect(events).toContainEqual({ type: "task_updated", id: task.id, taskKey: task.task_key });
      const after = await agent.get(`/api/tasks/${task.id}/run-preview`).expect(200);
      expect(after.body.preview.system_prompt).not.toContain("Remove this obsolete guidance.");
    });
  });

  it("rejects non-human comments without deleting them", async () => {
    const { agent, db } = makeTestServer();
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" }).expect(201);
    db.prepare("INSERT INTO task_comments (id, task_id, author_type, body, created_at) VALUES (?, ?, 'system', ?, ?)")
      .run("comment-system", task.id, "System history", Date.now());
    db.prepare("INSERT INTO task_comments (id, task_id, author_type, body, created_at) VALUES (?, ?, 'agent', ?, ?)")
      .run("comment-agent", task.id, "Agent history", Date.now());

    const system = await agent.delete(`/api/tasks/${task.id}/comments/comment-system`).expect(403);
    const agentComment = await agent.delete(`/api/tasks/${task.id}/comments/comment-agent`).expect(403);

    expect(system.body.error.code).toBe("forbidden");
    expect(agentComment.body.error.code).toBe("forbidden");
    expect(db.prepare("SELECT COUNT(*) AS count FROM task_comments WHERE task_id = ?").get(task.id).count).toBe(2);
  });

  it("accepts activity item ids prefixed with c-", async () => {
    const { agent, db } = makeTestServer();
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" }).expect(201);
    const { body: { comment } } = await agent.post(`/api/tasks/${task.id}/comments`)
      .send({ body: "delete from activity" })
      .expect(201);

    await agent.delete(`/api/tasks/${task.id}/comments/c-${comment.id}`).expect(204);

    expect(db.prepare("SELECT COUNT(*) AS count FROM task_comments WHERE id = ?").get(comment.id).count).toBe(0);
  });

  it("returns 404 for a missing task or missing comment", async () => {
    const { agent } = makeTestServer();
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" }).expect(201);

    await agent.delete("/api/tasks/missing/comments/comment-missing").expect(404);
    await agent.delete(`/api/tasks/${task.id}/comments/comment-missing`).expect(404);
  });
});

describe("GET /api/tasks/:id/runs", () => {
  it("returns empty list for new task", async () => {
    const { agent } = makeTestServer();
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    const res = await agent.get(`/api/tasks/${task.id}/runs`).expect(200);
    expect(res.body).toEqual({ runs: [] });
  });

  it("returns runs with compact log metadata", async () => {
    const { agent, db } = makeTestServer();
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    db.prepare(
      "INSERT INTO task_runs (id, task_id, mode, agent_name, started_at, status) VALUES (?, ?, 'execute', 'alpha', ?, 'complete')",
    ).run("run-with-log", task.id, 1000);
    db.prepare(`
      INSERT INTO agent_logs
        (id, task_run_id, events, model, effort, input_tokens, output_tokens, cost_usd, duration_ms, num_turns, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("log-1", "run-with-log", "[]", "model-a", "medium", 10, 5, 0.001, 250, 1, "complete", 1250);

    const res = await agent.get(`/api/tasks/${task.id}/runs`).expect(200);

    expect(res.body.runs[0].log).toMatchObject({
      id: "log-1",
      model: "model-a",
      input_tokens: 10,
      output_tokens: 5,
      duration_ms: 250,
      num_turns: 1,
    });
  });
});

describe("GET /api/tasks/:id/run-preview", () => {
  it("returns the next plan run system prompt and user message", async () => {
    await withPreviewServer(async ({ agent, db }) => {
      seedAgent(db, "planner", { instructions: "Plan carefully." });
      const { body: { task } } = await agent.post("/api/tasks").send({
        title: "Preview task",
        instructions: "Inspect the current prompt.",
        stage: "plan",
        owner_agent: "planner",
      }).expect(201);

      const res = await agent.get(`/api/tasks/${task.id}/run-preview`).expect(200);

      expect(res.body.preview).toMatchObject({
        task_id: task.id,
        task_key: task.task_key,
        stage: "plan",
        mode: "plan",
        agent_name: "planner",
        model: "claude:claude-sonnet-4-6",
        effort: "medium",
      });
      expect(res.body.preview.messages[0]).toMatchObject({ role: "user" });
      expect(res.body.preview.messages[0].content).toContain("# Plan task");
      expect(res.body.preview.messages[0].content).toContain('Task: "Preview task"');
      expect(res.body.preview.input.messages[0]).toMatchObject({ role: "user", format: "markdown" });
      expect(res.body.preview.system_prompt).toContain("Plan carefully.");
      expect(res.body.preview.system_prompt).toContain("Inspect the current prompt.");
      expect(res.body.preview.system_prompt).toContain("Plan this task.");
      expect(res.body.preview.input.system).toMatchObject({ format: "markdown", content: res.body.preview.system_prompt });
      expect(res.body.preview.input.tools[0]).toMatchObject({ name: "run_log_read" });
    });
  });

  it("uses explicit planner assignment for plan run preview", async () => {
    await withPreviewServer(async ({ agent, db }) => {
      seedAgent(db, "owner", { instructions: "Own implementation." });
      seedAgent(db, "planner", { instructions: "Plan carefully." });
      const { body: { task } } = await agent.post("/api/tasks").send({
        title: "Specialized planning",
        stage: "plan",
        owner_agent: "owner",
        planner_agent: "planner",
      }).expect(201);

      const res = await agent.get(`/api/tasks/${task.id}/run-preview`).expect(200);

      expect(res.body.preview).toMatchObject({
        stage: "plan",
        mode: "plan",
        agent_name: "planner",
      });
      expect(res.body.preview.system_prompt).toContain("Plan carefully.");
      expect(res.body.preview.system_prompt).not.toContain("Own implementation.");
    });
  });

  it("returns execute preview with prior run history", async () => {
    await withPreviewServer(async ({ agent, db }) => {
      seedAgent(db, "owner", { instructions: "Ship the change." });
      const { body: { task } } = await agent.post("/api/tasks").send({
        title: "Retry preview",
        instructions: "Finish the work.",
        stage: "execute",
        owner_agent: "owner",
      }).expect(201);
      db.prepare(
        "INSERT INTO task_runs (id, task_id, mode, stage, agent_name, started_at, ended_at, status, process_status) VALUES (?, ?, 'execute', 'execute', 'owner', ?, ?, 'error', 'failed')",
      ).run("run-old", task.id, 1000, 2000);
      db.prepare("INSERT INTO agent_logs (id, task_run_id, events, status, created_at) VALUES (?, ?, ?, 'error', ?)")
        .run("log-old", "run-old", JSON.stringify([{ type: "final", text: "Tried a first pass fix.", numTurns: 2, durationMs: 1000 }]), 2000);

      const res = await agent.get(`/api/tasks/${task.task_key}/run-preview`).expect(200);

      expect(res.body.preview.mode).toBe("execute");
      expect(res.body.preview.messages[0].content).toContain("# Work on task");
      expect(res.body.preview.messages[0].content).toContain('Task: "Retry preview"');
      expect(res.body.preview.system_prompt).toContain("## Prior run history");
      expect(res.body.preview.system_prompt).toContain("- Run id: run-old");
      expect(res.body.preview.system_prompt).toContain("Tried a first pass fix.");
      expect(res.body.preview.system_prompt).toContain("## Available run logs");
      expect(res.body.preview.system_prompt).toContain("run_log_read");
      expect(res.body.preview.system_prompt).toContain("Do the task work requested by the instructions.");
    });
  });

  it("returns review preview with the prior execute output", async () => {
    await withPreviewServer(async ({ agent, db }) => {
      seedAgent(db, "owner", { instructions: "Implement." });
      seedAgent(db, "reviewer", { instructions: "Review strictly." });
      const { body: { task } } = await agent.post("/api/tasks").send({
        title: "Review preview",
        instructions: "Check the patch.",
        stage: "review",
        owner_agent: "owner",
        reviewer_agent: "reviewer",
      }).expect(201);
      db.prepare(
        "INSERT INTO task_runs (id, task_id, mode, stage, agent_name, started_at, ended_at, status, process_status) VALUES (?, ?, 'execute', 'execute', 'owner', ?, ?, 'complete', 'succeeded')",
      ).run("run-exec", task.id, 1000, 2000);
      db.prepare("INSERT INTO agent_logs (id, task_run_id, events, status, created_at) VALUES (?, ?, ?, 'complete', ?)")
        .run("log-exec", "run-exec", JSON.stringify([{ type: "final", text: "Implemented the requested change.", numTurns: 3, durationMs: 1500 }]), 2000);

      const res = await agent.get(`/api/tasks/${task.id}/run-preview`).expect(200);

      expect(res.body.preview).toMatchObject({
        stage: "review",
        mode: "review",
        agent_name: "reviewer",
      });
      expect(res.body.preview.messages[0].content).toContain("# Review task");
      expect(res.body.preview.messages[0].content).toContain('Task: "Review preview"');
      expect(res.body.preview.system_prompt).toContain("Review strictly.");
      expect(res.body.preview.system_prompt).toContain("## Work output (by owner");
      expect(res.body.preview.system_prompt).toContain("Run id: `run-exec`");
      expect(res.body.preview.system_prompt).toContain("run_log_read");
      expect(res.body.preview.system_prompt).toContain("Implemented the requested change.");
    });
  });

  it("rejects preview when no runnable agent is assigned", async () => {
    await withPreviewServer(async ({ agent }) => {
      const { body: { task } } = await agent.post("/api/tasks").send({ title: "Needs owner", stage: "plan" }).expect(201);

      const res = await agent.get(`/api/tasks/${task.id}/run-preview`).expect(400);

      expect(res.body.error).toMatchObject({ code: "invalid_state", message: "no planner or owner assigned" });
    });
  });

  it("rejects preview when an unresolved dependency blocks the task", async () => {
    await withPreviewServer(async ({ agent, db }) => {
      seedAgent(db, "owner");
      const { body: { task: blocker } } = await agent.post("/api/tasks").send({ title: "Blocker" }).expect(201);
      const { body: { task } } = await agent.post("/api/tasks").send({
        title: "Blocked",
        stage: "execute",
        owner_agent: "owner",
        blocked_by_ids: [blocker.id],
      }).expect(201);

      const res = await agent.get(`/api/tasks/${task.id}/run-preview`).expect(400);

      expect(res.body.error).toMatchObject({ code: "invalid_state" });
      expect(res.body.error.message).toContain('task is blocked by "Blocker"');
    });
  });

  it("rejects review preview without a prior execute run", async () => {
    await withPreviewServer(async ({ agent, db }) => {
      seedAgent(db, "owner");
      seedAgent(db, "reviewer");
      const { body: { task } } = await agent.post("/api/tasks").send({
        title: "Review without work",
        stage: "review",
        owner_agent: "owner",
        reviewer_agent: "reviewer",
      }).expect(201);

      const res = await agent.get(`/api/tasks/${task.id}/run-preview`).expect(400);

      expect(res.body.error).toMatchObject({ code: "invalid_state", message: "no execute run to review" });
    });
  });
});

describe("GET /api/tasks with filters", () => {
  it("filters by stage", async () => {
    const { agent } = makeTestServer();
    await agent.post("/api/tasks").send({ title: "a" });
    const { body: { task: b } } = await agent.post("/api/tasks").send({ title: "b" });
    await agent.patch(`/api/tasks/${b.id}`).send({ stage: "review" });
    const res = await agent.get("/api/tasks?stage=review").expect(200);
    expect(res.body.tasks.length).toBe(1);
    expect(res.body.tasks[0].id).toBe(b.id);
  });

  it("filters by agent (owner, planner, or reviewer match)", async () => {
    const { agent, db } = makeTestServer();
    const now = Date.now();
    db.prepare(`INSERT INTO agents (name, display_name, sdk, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("alice", "Alice", "claude", "claude:claude-sonnet-4-6", now, now);
    const { body: { task: t1 } } = await agent.post("/api/tasks").send({ title: "x" });
    const { body: { task: t2 } } = await agent.post("/api/tasks").send({ title: "y" });
    const { body: { task: t3 } } = await agent.post("/api/tasks").send({ title: "z" });
    await agent.patch(`/api/tasks/${t1.id}`).send({ owner_agent: "alice" });
    await agent.patch(`/api/tasks/${t2.id}`).send({ reviewer_agent: "alice" });
    await agent.patch(`/api/tasks/${t3.id}`).send({ planner_agent: "alice" });
    await agent.post("/api/tasks").send({ title: "unrelated" });
    const res = await agent.get("/api/tasks?agent=alice").expect(200);
    expect(res.body.tasks.map(t => t.id).sort()).toEqual([t1.id, t2.id, t3.id].sort());
  });

  it("combines filters", async () => {
    const { agent, db } = makeTestServer();
    const now = Date.now();
    db.prepare(`INSERT INTO agents (name, display_name, sdk, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("bob", "Bob", "claude", "claude:claude-sonnet-4-6", now, now);
    const { body: { task: t } } = await agent.post("/api/tasks").send({ title: "t" });
    await agent.patch(`/api/tasks/${t.id}`).send({ owner_agent: "bob", stage: "review" });
    await agent.post("/api/tasks").send({ title: "other" });
    const res = await agent.get("/api/tasks?stage=review&agent=bob").expect(200);
    expect(res.body.tasks.length).toBe(1);
    expect(res.body.tasks[0].id).toBe(t.id);
  });
});

describe("POST /api/tasks/:id/run", () => {
  it("invokes watcher.handleRunRequested", async () => {
    const calls = [];
    const { agent } = makeTestServer({
      watcher: {
        handleRunRequested: async (id) => { calls.push(id); return { runId: "r1" }; },
        cancel: () => true, shutdown: async () => {}, isActive: () => false,
      },
    });
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    const res = await agent.post(`/api/tasks/${task.id}/run`).expect(200);
    expect(res.body.runId).toBe("r1");
    expect(calls).toEqual([task.id]);
  });

  it("returns 400 when watcher throws (e.g., no owner)", async () => {
    const { agent } = makeTestServer({
      watcher: {
        handleRunRequested: async () => { throw new Error("no owner assigned"); },
        cancel: () => true, shutdown: async () => {}, isActive: () => false,
      },
    });
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    const res = await agent.post(`/api/tasks/${task.id}/run`).expect(400);
    expect(res.body.error.message).toMatch(/no owner/);
  });
});

describe("POST /api/tasks/:id/retry", () => {
  it("dispatches handleRunRequested for retryable stages", async () => {
    const calls = [];
    const { agent, db } = makeTestServer({
      watcher: {
        handleRunRequested: async (id) => { calls.push(id); return { runId: "r-x" }; },
        cancel: () => true, shutdown: async () => {}, isActive: () => false,
      },
    });
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    db.prepare("UPDATE tasks SET stage = 'execute', error_text = 'old', updated_at = ? WHERE id = ?").run(Date.now(), task.id);
    const res = await agent.post(`/api/tasks/${task.id}/retry`).expect(200);
    expect(res.body.runId).toBe("r-x");
    expect(calls).toEqual([task.id]);
  });

  it("transitions blocked tasks back to execute before running", async () => {
    const calls = [];
    const { agent, db } = makeTestServer({
      watcher: {
        handleRunRequested: async (id) => { calls.push(id); return { runId: "r-y" }; },
        cancel: () => true, shutdown: async () => {}, isActive: () => false,
      },
    });
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    db.prepare("UPDATE tasks SET stage = 'blocked', error_text = 'too many failures', updated_at = ? WHERE id = ?").run(Date.now(), task.id);
    await agent.post(`/api/tasks/${task.id}/retry`).expect(200);
    const after = db.prepare("SELECT stage, error_text, retry_count FROM tasks WHERE id = ?").get(task.id);
    expect(after.stage).toBe("execute");
    expect(after.error_text).toBeNull();
    expect(after.retry_count).toBe(0);
    expect(calls).toEqual([task.id]);
  });

  it("transitions blocked tasks back to their latest retry_stage before running", async () => {
    const calls = [];
    const { agent, db } = makeTestServer({
      watcher: {
        handleRunRequested: async (id) => {
          calls.push(db.prepare("SELECT stage FROM tasks WHERE id = ?").get(id).stage);
          return { runId: "r-review" };
        },
        cancel: () => true, shutdown: async () => {}, isActive: () => false,
      },
    });
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    const now = Date.now();
    db.prepare("UPDATE tasks SET stage = 'blocked', error_text = 'bad review', updated_at = ? WHERE id = ?").run(now, task.id);
    db.prepare(`
      INSERT INTO task_runs (id, task_id, mode, stage, agent_name, status, process_status, retry_stage, started_at, ended_at)
      VALUES ('review-fail', ?, 'review', 'review', 'checker', 'error', 'failed', 'review', ?, ?)
    `).run(task.id, now - 1000, now - 500);

    await agent.post(`/api/tasks/${task.id}/retry`).expect(200);

    const after = db.prepare("SELECT stage, error_text, retry_count FROM tasks WHERE id = ?").get(task.id);
    expect(after.stage).toBe("review");
    expect(after.error_text).toBeNull();
    expect(after.retry_count).toBe(0);
    expect(calls).toEqual(["review"]);
  });

  it("rejects retry for stages that aren't retryable", async () => {
    const { agent, db } = makeTestServer({
      watcher: {
        handleRunRequested: async () => ({ runId: "r" }),
        cancel: () => true, shutdown: async () => {}, isActive: () => false,
      },
    });
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    db.prepare("UPDATE tasks SET stage = 'done', completed_at = ?, updated_at = ? WHERE id = ?").run(Date.now(), Date.now(), task.id);
    const res = await agent.post(`/api/tasks/${task.id}/retry`).expect(400);
    expect(res.body.error.code).toBe("invalid_state");
    expect(res.body.error.message).toMatch(/cannot retry from done/);
  });
});

describe("POST /api/tasks/:id/cancel", () => {
  it("invokes watcher.cancel when active", async () => {
    const cancelFn = vi.fn(() => true);
    const { agent } = makeTestServer({
      watcher: {
        handleRunRequested: async () => ({ runId: "r" }),
        cancel: cancelFn,
        shutdown: async () => {},
        isActive: () => true,
      },
    });
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    await agent.post(`/api/tasks/${task.id}/cancel`).expect(204);
    expect(cancelFn).toHaveBeenCalledWith(task.id, { initiator: "api_cancel", reason: null });
  });

  it("returns 404 when no active run", async () => {
    const { agent } = makeTestServer({
      watcher: {
        handleRunRequested: async () => ({ runId: "r" }),
        cancel: () => false,
        shutdown: async () => {},
        isActive: () => false,
      },
    });
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    await agent.post(`/api/tasks/${task.id}/cancel`).expect(404);
  });

  it("reconciles stale running runs when no live worker", async () => {
    const { agent, db, broker } = makeTestServer({
      watcher: {
        handleRunRequested: async () => ({ runId: "r" }),
        cancel: () => false,
        shutdown: async () => {},
        isActive: () => false,
      },
    });
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    db.prepare(
      `UPDATE tasks SET stage = 'execute', updated_at = ? WHERE id = ?`,
    ).run(Date.now(), task.id);
    db.prepare(
      `INSERT INTO task_runs (id, task_id, mode, agent_name, status, started_at)
       VALUES ('stale1', ?, 'execute', 'claude', 'running', ?)`,
    ).run(task.id, Date.now() - 1000);

    const events = [];
    broker.broadcast = (ch, p) => events.push({ ch, p });

    await agent.post(`/api/tasks/${task.id}/cancel`).expect(204);

    const run = db.prepare("SELECT status, process_status, failure_kind, error_text FROM task_runs WHERE id = 'stale1'").get();
    expect(run.status).toBe("error");
    expect(run.process_status).toBe("abandoned");
    expect(run.failure_kind).toBe("abandoned");
    expect(run.error_text).toBe("worker exited");

    const t = db.prepare("SELECT stage, stage_reason, error_text FROM tasks WHERE id = ?").get(task.id);
    expect(t.stage).toBe("execute");
    expect(t.stage_reason).toBe("abandoned");
    expect(t.error_text).toBe("Previous run did not finish");

    const endEvent = events.find((e) => e.p?.type === "run_ended")?.p;
    expect(endEvent).toMatchObject({
      runId: "stale1",
      taskId: task.id,
      taskTitle: "t",
      status: "error",
      processStatus: "abandoned",
      failureKind: "abandoned",
      errorText: "worker exited",
    });
    expect(events.some((e) => e.p?.type === "task_updated")).toBe(true);
  });
});
