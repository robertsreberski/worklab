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
    expect(res.body.task.task_key).toBe("T-1");
    expect(res.body.task.title).toBe("do thing");
    expect(res.body.task.status).toBeUndefined();
    expect(res.body.task.stage).toBe("plan");
    expect(res.body.task.run_policy).toBe("auto_plan_execute");
    expect(res.body.task.root_task_id).toBe(res.body.task.id);
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

  it("stores owner assignment", async () => {
    const { agent, db } = makeTestServer();
    const now = Date.now();
    db.prepare(`INSERT INTO agents (name, display_name, sdk, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("coder", "Coder", "claude", "claude:claude-sonnet-4-6", now, now);
    const { body: { task } } = await agent.post("/api/tasks").send({
      title: "owned",
      owner_agent: "coder",
    }).expect(201);
    expect(task.owner_agent).toBe("coder");
    expect(task.executor_agent).toBeUndefined();

    const res = await agent.patch(`/api/tasks/${task.id}`).send({ owner_agent: null }).expect(200);
    expect(res.body.task.owner_agent).toBeNull();
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
  it("bulk patches owner, reviewer, and run policy", async () => {
    const { agent, db } = makeTestServer();
    const now = Date.now();
    db.prepare(`INSERT INTO agents (name, display_name, sdk, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("owner", "Owner", "claude", "claude:claude-sonnet-4-6", now, now);
    db.prepare(`INSERT INTO agents (name, display_name, sdk, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("reviewer", "Reviewer", "claude", "claude:claude-sonnet-4-6", now, now);
    const { body: { task: a } } = await agent.post("/api/tasks").send({ title: "a" }).expect(201);
    const { body: { task: b } } = await agent.post("/api/tasks").send({ title: "b" }).expect(201);

    const res = await agent.post("/api/tasks/bulk").send({
      ids: [a.task_key, b.task_key],
      operation: "patch",
      patch: {
        owner_agent: "owner",
        reviewer_agent: "reviewer",
        run_policy: "auto_plan_execute",
      },
    }).expect(200);

    expect(res.body.summary).toEqual({ requested: 2, succeeded: 2, failed: 0 });
    expect(res.body.results.map((result) => result.task_id).sort()).toEqual([a.id, b.id].sort());
    expect(res.body.results.every((result) => result.ok)).toBe(true);
    const rows = db.prepare("SELECT owner_agent, reviewer_agent, run_policy FROM tasks ORDER BY title").all();
    expect(rows).toEqual([
      { owner_agent: "owner", reviewer_agent: "reviewer", run_policy: "auto_plan_execute" },
      { owner_agent: "owner", reviewer_agent: "reviewer", run_policy: "auto_plan_execute" },
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
    const { body: { task: parent } } = await agent.post("/api/tasks").send({
      title: "Parent",
      owner_agent: "owner",
    }).expect(201);

    const res = await agent.post(`/api/tasks/${parent.task_key}/subtasks`).send({ title: "Child" }).expect(201);

    expect(res.body.task).toMatchObject({
      task_key: "T-2",
      title: "Child",
      parent_task_id: parent.id,
      root_task_id: parent.id,
      owner_agent: "owner",
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

  it("filters by agent (owner OR reviewer match)", async () => {
    const { agent, db } = makeTestServer();
    const now = Date.now();
    db.prepare(`INSERT INTO agents (name, display_name, sdk, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("alice", "Alice", "claude", "claude:claude-sonnet-4-6", now, now);
    const { body: { task: t1 } } = await agent.post("/api/tasks").send({ title: "x" });
    const { body: { task: t2 } } = await agent.post("/api/tasks").send({ title: "y" });
    await agent.patch(`/api/tasks/${t1.id}`).send({ owner_agent: "alice" });
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

    expect(events.some((e) => e.p?.type === "run_ended")).toBe(true);
    expect(events.some((e) => e.p?.type === "task_updated")).toBe(true);
  });
});
