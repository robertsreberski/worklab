import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeTestServer } from "../helpers/test-server.js";

describe("GET /api/tasks", () => {
  it("returns empty list initially", async () => {
    const { agent } = makeTestServer();
    const res = await agent.get("/api/tasks").expect(200);
    expect(res.body).toEqual({ tasks: [] });
  });
});

describe("POST /api/tasks", () => {
  it("creates a task with required fields", async () => {
    const { agent } = makeTestServer();
    const res = await agent.post("/api/tasks").send({ title: "do thing" }).expect(201);
    expect(res.body.task.id).toMatch(/^[a-zA-Z0-9]{21}$/);
    expect(res.body.task.title).toBe("do thing");
    expect(res.body.task.status).toBe("todo");
    expect(res.body.task.stage).toBe("execute");
    expect(res.body.task.root_task_id).toBe(res.body.task.id);
    expect(res.body.task.priority).toBeUndefined();
  });

  it("rejects missing title", async () => {
    const { agent } = makeTestServer();
    await agent.post("/api/tasks").send({}).expect(400);
  });

  it("returns new task in GET list", async () => {
    const { agent } = makeTestServer();
    await agent.post("/api/tasks").send({ title: "a" });
    await agent.post("/api/tasks").send({ title: "b" });
    const res = await agent.get("/api/tasks").expect(200);
    expect(res.body.tasks.map(t => t.title).sort()).toEqual(["a", "b"]);
  });

  it("stores dependency ids and exposes compact blockers", async () => {
    const { agent } = makeTestServer();
    const { body: { task: blocker } } = await agent.post("/api/tasks").send({ title: "Blocker" }).expect(201);
    const { body: { task } } = await agent.post("/api/tasks").send({
      title: "Blocked task",
      blocked_by_ids: [blocker.id],
    }).expect(201);
    expect(task.dependency_ids).toEqual([blocker.id]);
    expect(task.blocked_by).toHaveLength(1);
    expect(task.blocked_by[0]).toMatchObject({ id: blocker.id, title: "Blocker" });
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

  it("PATCH broadcasts task_updated", async () => {
    const { agent, broker } = makeTestServer();
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "a" });
    let got = null;
    broker.broadcast = (ch, p) => { if (ch === "global" && p.type === "task_updated") got = p; };
    await agent.patch(`/api/tasks/${task.id}`).send({ title: "b" });
    expect(got).toEqual({ type: "task_updated", id: task.id });
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
    expect(res.body.task.status).toBe("in_review");
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

  it("moving done → execute clears completed_at", async () => {
    const { agent } = makeTestServer();
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    await agent.patch(`/api/tasks/${task.id}`).send({ stage: "done" });
    const res = await agent.patch(`/api/tasks/${task.id}`).send({ stage: "execute" });
    expect(res.body.task.completed_at).toBeNull();
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
  it("creates a human comment", async () => {
    const { agent } = makeTestServer();
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    const res = await agent.post(`/api/tasks/${task.id}/comments`).send({ body: "a note" }).expect(201);
    expect(res.body.comment.body).toBe("a note");
    expect(res.body.comment.author_type).toBe("human");
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

  it("filters by agent (executor OR reviewer match)", async () => {
    const { agent, db } = makeTestServer();
    const now = Date.now();
    db.prepare(`INSERT INTO agents (name, display_name, sdk, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("alice", "Alice", "claude", "claude:claude-sonnet-4-6", now, now);
    const { body: { task: t1 } } = await agent.post("/api/tasks").send({ title: "x" });
    const { body: { task: t2 } } = await agent.post("/api/tasks").send({ title: "y" });
    await agent.patch(`/api/tasks/${t1.id}`).send({ executor_agent: "alice" });
    await agent.patch(`/api/tasks/${t2.id}`).send({ reviewer_agent: "alice" });
    await agent.post("/api/tasks").send({ title: "unrelated" });
    const res = await agent.get("/api/tasks?agent=alice").expect(200);
    expect(res.body.tasks.map(t => t.id).sort()).toEqual([t1.id, t2.id].sort());
  });

  it("combines filters", async () => {
    const { agent, db } = makeTestServer();
    const now = Date.now();
    db.prepare(`INSERT INTO agents (name, display_name, sdk, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("bob", "Bob", "claude", "claude:claude-sonnet-4-6", now, now);
    const { body: { task: t } } = await agent.post("/api/tasks").send({ title: "t" });
    await agent.patch(`/api/tasks/${t.id}`).send({ executor_agent: "bob", stage: "review" });
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

  it("returns 400 when watcher throws (e.g., no executor)", async () => {
    const { agent } = makeTestServer({
      watcher: {
        handleRunRequested: async () => { throw new Error("no executor assigned"); },
        cancel: () => true, shutdown: async () => {}, isActive: () => false,
      },
    });
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    const res = await agent.post(`/api/tasks/${task.id}/run`).expect(400);
    expect(res.body.error.message).toMatch(/no executor/);
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
    expect(cancelFn).toHaveBeenCalledWith(task.id);
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
      `UPDATE tasks SET status = 'in_progress', stage = 'execute', updated_at = ? WHERE id = ?`,
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

    const t = db.prepare("SELECT status, stage, stage_reason, error_text FROM tasks WHERE id = ?").get(task.id);
    expect(t.status).toBe("todo");
    expect(t.stage).toBe("execute");
    expect(t.stage_reason).toBe("abandoned");
    expect(t.error_text).toBe("Previous run did not finish");

    expect(events.some((e) => e.p?.type === "run_ended")).toBe(true);
    expect(events.some((e) => e.p?.type === "task_updated")).toBe(true);
  });
});
