import { describe, it, expect, beforeEach } from "vitest";
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
    expect(res.body.task.priority).toBe(0);
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
});

describe("PATCH /api/tasks/:id", () => {
  it("updates title, description, instructions", async () => {
    const { agent } = makeTestServer();
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "orig" });
    const res = await agent.patch(`/api/tasks/${task.id}`).send({ title: "new", description: "desc" });
    expect(res.body.task.title).toBe("new");
    expect(res.body.task.description).toBe("desc");
  });

  it("PATCH broadcasts task_updated", async () => {
    const { agent, broker } = makeTestServer();
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "a" });
    let got = null;
    broker.broadcast = (ch, p) => { if (ch === "global" && p.type === "task_updated") got = p; };
    await agent.patch(`/api/tasks/${task.id}`).send({ title: "b" });
    expect(got).toEqual({ type: "task_updated", id: task.id });
  });
});

describe("PATCH /api/tasks/:id status", () => {
  it("human_move todo → in_progress when allowed", async () => {
    const { agent } = makeTestServer();
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    const res = await agent.patch(`/api/tasks/${task.id}`).send({ status: "in_progress" });
    expect(res.body.task.status).toBe("in_progress");
  });

  it("invalid status value returns 400", async () => {
    const { agent } = makeTestServer();
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    await agent.patch(`/api/tasks/${task.id}`).send({ status: "bogus" }).expect(400);
  });

  it("setting status=done sets completed_at", async () => {
    const { agent } = makeTestServer();
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    await agent.patch(`/api/tasks/${task.id}`).send({ status: "in_review" });
    const res = await agent.patch(`/api/tasks/${task.id}`).send({ status: "done" });
    expect(res.body.task.completed_at).toBeTruthy();
  });

  it("moving done → todo clears completed_at", async () => {
    const { agent } = makeTestServer();
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    await agent.patch(`/api/tasks/${task.id}`).send({ status: "done" });
    const res = await agent.patch(`/api/tasks/${task.id}`).send({ status: "todo" });
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
});
