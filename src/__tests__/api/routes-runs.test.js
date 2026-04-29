import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestServer } from "../helpers/test-server.js";
import { newRunId, newTaskId } from "../../core/ids.js";
import { createWatcherProxy } from "../../coordinator.js";

describe("GET /api/runs/:id", () => {
  it("returns 404 for missing run", async () => {
    const { agent } = makeTestServer();
    await agent.get("/api/runs/nope").expect(404);
  });

  it("returns run with embedded log events", async () => {
    const { agent, db } = makeTestServer();
    const taskId = newTaskId();
    const runId = newRunId();
    const now = Date.now();
    db.prepare("INSERT INTO tasks (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(taskId, "t", now, now);
    db.prepare("INSERT INTO task_runs (id, task_id, mode, agent_name, started_at, status) VALUES (?, ?, 'execute', 'a', ?, 'complete')")
      .run(runId, taskId, now);
    db.prepare("INSERT INTO agent_logs (id, task_run_id, events, status, created_at) VALUES (?, ?, ?, 'complete', ?)")
      .run("log1", runId, JSON.stringify([{type:"final",text:"ok"}]), now);
    const res = await agent.get(`/api/runs/${runId}`).expect(200);
    expect(res.body.run.id).toBe(runId);
    expect(res.body.log.events.length).toBe(1);
  });

  it("returns events for a still-running run", async () => {
    const { agent, db } = makeTestServer();
    const taskId = newTaskId();
    const runId = newRunId();
    const now = Date.now();
    db.prepare("INSERT INTO tasks (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(taskId, "t", now, now);
    db.prepare("INSERT INTO task_runs (id, task_id, mode, agent_name, started_at, status, process_status) VALUES (?, ?, 'execute', 'a', ?, 'running', 'running')")
      .run(runId, taskId, now);
    db.prepare("INSERT INTO agent_logs (id, task_run_id, events, status, created_at) VALUES (?, ?, ?, 'running', ?)")
      .run("log-running", runId, JSON.stringify([{ type: "text", text: "still working", _event_seq: 1 }]), now);

    const res = await agent.get(`/api/runs/${runId}`).expect(200);

    expect(res.body.run.process_status).toBe("running");
    expect(res.body.run.live_input).toMatchObject({ supported: false, active: false });
    expect(res.body.log.events).toEqual([{ type: "text", text: "still working", _event_seq: 1 }]);
  });

  it("can return only the tail of run events", async () => {
    const { agent, db } = makeTestServer();
    const taskId = newTaskId();
    const runId = newRunId();
    const now = Date.now();
    db.prepare("INSERT INTO tasks (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(taskId, "t", now, now);
    db.prepare("INSERT INTO task_runs (id, task_id, mode, agent_name, started_at, status) VALUES (?, ?, 'execute', 'a', ?, 'complete')")
      .run(runId, taskId, now);
    db.prepare("INSERT INTO agent_logs (id, task_run_id, events, status, created_at) VALUES (?, ?, ?, 'complete', ?)")
      .run("log-tail", runId, JSON.stringify([
        { type: "text", _event_seq: 1 },
        { type: "text", _event_seq: 2 },
        { type: "final", _event_seq: 3 },
      ]), now);

    const res = await agent.get(`/api/runs/${runId}?events=tail&limit=2`).expect(200);

    expect(res.body.log.event_count).toBe(3);
    expect(res.body.log.events_truncated).toBe(true);
    expect(res.body.log.events.map((event) => event._event_seq)).toEqual([2, 3]);
  });

  it("returns a run raw log when the path is inside the data dir", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "worklab-raw-log-"));
    try {
      const { agent, db } = makeTestServer({ dataDir });
      const taskId = newTaskId();
      const runId = newRunId();
      const now = Date.now();
      const rawDir = join(dataDir, "logs", "runs");
      const rawPath = join(rawDir, `${runId}.jsonl`);
      mkdirSync(rawDir, { recursive: true });
      writeFileSync(rawPath, "{\"type\":\"started\"}\n");
      db.prepare("INSERT INTO tasks (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(taskId, "t", now, now);
      db.prepare("INSERT INTO task_runs (id, task_id, mode, agent_name, started_at, status, raw_output_path) VALUES (?, ?, 'execute', 'a', ?, 'complete', ?)")
        .run(runId, taskId, now, rawPath);

      const res = await agent.get(`/api/runs/${runId}/raw-log`).expect(200);
      expect(res.text).toBe("{\"type\":\"started\"}\n");
      expect(res.headers["content-type"]).toMatch(/text\/plain/);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("POST /api/runs/:id/messages", () => {
  function seedRun(db, { providerKind = "claude", status = "running", processStatus = "running" } = {}) {
    const taskId = newTaskId();
    const runId = newRunId();
    const now = Date.now();
    db.prepare("INSERT INTO tasks (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(taskId, "t", now, now);
    db.prepare(
      `INSERT INTO task_runs
        (id, task_id, mode, agent_name, provider_kind, started_at, status, process_status)
       VALUES (?, ?, 'execute', 'a', ?, ?, ?, ?)`,
    ).run(runId, taskId, providerKind, now, status, processStatus);
    return { taskId, runId };
  }

  it("persists and delivers a live run message", async () => {
    const deliveries = [];
    const watcher = {
      handleRunRequested: async () => ({ runId: "fake-run" }),
      cancel: () => true,
      shutdown: async () => {},
      isActive: () => true,
      isRunActive: () => true,
      getRunLiveInputState: () => ({ supported: true, active: true, reason: null }),
      sendRunMessage: async (runId, message) => {
        deliveries.push({ runId, message });
        return { ok: true };
      },
      maybeAutoStart: () => {},
      maybeAutoStartDependents: () => {},
    };
    const { agent, db, broker } = makeTestServer({ watcher });
    const { taskId, runId } = seedRun(db);

    const res = await agent.post(`/api/runs/${runId}/messages`)
      .send({ body: "Please inspect the migration path." })
      .expect(202);

    expect(res.body.delivered).toBe(true);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      runId,
      message: {
        id: res.body.message.id,
        body: "Please inspect the migration path.",
        authorType: "human",
      },
    });
    const comment = db.prepare("SELECT * FROM task_comments WHERE task_id = ?").get(taskId);
    expect(comment).toMatchObject({
      id: res.body.message.id,
      author_type: "human",
      body: "Please inspect the migration path.",
    });
    expect(broker.size("global")).toBe(0);
  });

  it("delivers live run messages through the coordinator watcher proxy", async () => {
    const deliveries = [];
    const watcherHolder = {
      current: {
        handleRunRequested: async () => ({ runId: "fake-run" }),
        cancel: () => true,
        shutdown: async () => {},
        isActive: () => true,
        isRunActive: () => true,
        getRunLiveInputState: () => ({ supported: true, active: true, reason: null }),
        sendRunMessage: async (runId, message) => {
          deliveries.push({ runId, message });
          return { ok: true };
        },
        maybeAutoStart: () => {},
        maybeAutoStartDependents: () => {},
      },
    };
    const { agent, db } = makeTestServer({ watcher: createWatcherProxy(watcherHolder) });
    const { runId } = seedRun(db, { providerKind: "codex" });

    await agent.post(`/api/runs/${runId}/messages`)
      .send({ body: "Steer through the proxy." })
      .expect(202);

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      runId,
      message: { body: "Steer through the proxy.", authorType: "human" },
    });
  });

  it("rejects unsupported providers before creating a comment", async () => {
    const { agent, db } = makeTestServer();
    const { taskId, runId } = seedRun(db, { providerKind: "openai" });

    await agent.post(`/api/runs/${runId}/messages`)
      .send({ body: "Guide this." })
      .expect(409);

    const comments = db.prepare("SELECT * FROM task_comments WHERE task_id = ?").all(taskId);
    expect(comments).toHaveLength(0);
  });

  it("rejects inactive runs before creating a comment", async () => {
    const { agent, db } = makeTestServer();
    const { taskId, runId } = seedRun(db, { providerKind: "claude", status: "complete", processStatus: "succeeded" });

    await agent.post(`/api/runs/${runId}/messages`)
      .send({ body: "Too late." })
      .expect(409);

    expect(db.prepare("SELECT * FROM task_comments WHERE task_id = ?").all(taskId)).toHaveLength(0);
  });

  it("validates empty and oversized message bodies", async () => {
    const { agent, db } = makeTestServer();
    const { runId } = seedRun(db, { providerKind: "claude" });

    await agent.post(`/api/runs/${runId}/messages`).send({ body: "   " }).expect(400);
    await agent.post(`/api/runs/${runId}/messages`).send({ body: "x".repeat(8001) }).expect(400);
  });

  it("returns a delivery failure when persistence succeeds but worker delivery fails", async () => {
    const watcher = {
      handleRunRequested: async () => ({ runId: "fake-run" }),
      cancel: () => true,
      shutdown: async () => {},
      isActive: () => true,
      isRunActive: () => true,
      getRunLiveInputState: () => ({ supported: true, active: true, reason: null }),
      sendRunMessage: async () => ({ ok: false, code: "delivery_failed", message: "stdin closed" }),
      maybeAutoStart: () => {},
      maybeAutoStartDependents: () => {},
    };
    const { agent, db } = makeTestServer({ watcher });
    const { taskId, runId } = seedRun(db);

    const res = await agent.post(`/api/runs/${runId}/messages`)
      .send({ body: "Try another path." })
      .expect(409);

    expect(res.body.delivered).toBe(false);
    expect(res.body.error.code).toBe("delivery_failed");
    expect(db.prepare("SELECT * FROM task_comments WHERE task_id = ?").all(taskId)).toHaveLength(1);
  });
});

describe("GET /api/runs/:id/stream", () => {
  it("subscribes client to per-run SSE channel (returns text/event-stream)", async () => {
    const { agent } = makeTestServer();
    const req = agent.get("/api/runs/any-id/stream");
    req.set("Accept", "text/event-stream");
    const res = await new Promise((resolve) => {
      const r = req.buffer(false).parse((stream, callback) => {
        stream.on("data", (chunk) => {
          callback(null, chunk.toString());
          stream.destroy();
        });
      });
      r.end((err, response) => resolve(response));
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/event-stream/);
  });
});
