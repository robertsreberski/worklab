import { describe, it, expect } from "vitest";
import { makeTestServer } from "../helpers/test-server.js";

describe("activity", () => {
  it("returns empty when no runs", async () => {
    const { agent } = makeTestServer();
    const res = await agent.get("/api/activity").expect(200);
    expect(res.body).toEqual({ items: [], nextCursor: null });
  });

  it("returns runs with limit + cursor", async () => {
    const { agent, db } = makeTestServer();
    // seed two synthetic runs
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    const now = Date.now();
    db.prepare(`INSERT INTO task_runs (id, task_id, mode, agent_name, status, started_at, ended_at)
                VALUES (?, ?, 'execute', 'a', 'complete', ?, ?)`).run("r1", task.id, now - 1000, now);
    db.prepare(`INSERT INTO task_runs (id, task_id, mode, agent_name, status, started_at, ended_at)
                VALUES (?, ?, 'execute', 'a', 'complete', ?, ?)`).run("r2", task.id, now, now + 100);
    const res = await agent.get("/api/activity?limit=1").expect(200);
    expect(res.body.items.length).toBe(1);
    expect(res.body.items[0].id).toBe("r2");
    expect(res.body.nextCursor).toBeTruthy();
  });
});
