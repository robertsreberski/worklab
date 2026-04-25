import { describe, it, expect } from "vitest";
import { makeTestServer } from "../helpers/test-server.js";
import { newRunId, newTaskId } from "../../core/ids.js";

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
    expect(res.body.log.events).toEqual([{ type: "text", text: "still working", _event_seq: 1 }]);
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
