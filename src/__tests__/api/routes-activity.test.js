import { describe, it, expect } from "vitest";
import { makeTestServer } from "../helpers/test-server.js";

const EMPTY_SUMMARY = {
  run_count: 0,
  costed_run_count: 0,
  unpriced_run_count: 0,
  total_cost_usd: 0,
  average_cost_usd: null,
  running_count: 0,
  error_count: 0,
  cost_by_day: [],
};

function insertRun(db, patch = {}) {
  db.prepare(`
    INSERT INTO task_runs
      (id, task_id, mode, agent_name, status, process_status, started_at, ended_at, cost_usd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    patch.id,
    patch.taskId ?? null,
    patch.mode || "execute",
    patch.agent || "agent",
    patch.status || "complete",
    patch.processStatus || patch.status || "complete",
    patch.startedAt,
    patch.endedAt ?? patch.startedAt + 100,
    patch.costUsd ?? null,
  );
}

function insertLog(db, patch = {}) {
  db.prepare(`
    INSERT INTO agent_logs
      (id, task_run_id, events, model, input_tokens, output_tokens, cost_usd, duration_ms, num_turns, status, created_at)
    VALUES (?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    patch.id,
    patch.runId,
    patch.model || "test-model",
    patch.inputTokens ?? 0,
    patch.outputTokens ?? 0,
    patch.costUsd ?? null,
    patch.durationMs ?? null,
    patch.numTurns ?? null,
    patch.status || "complete",
    patch.createdAt ?? Date.now(),
  );
}

describe("activity", () => {
  it("returns empty when no runs", async () => {
    const { agent } = makeTestServer();
    const res = await agent.get("/api/activity").expect(200);
    expect(res.body).toEqual({ items: [], nextCursor: null, summary: EMPTY_SUMMARY });
  });

  it("returns runs with limit + cursor", async () => {
    const { agent, db } = makeTestServer();
    // seed two synthetic runs
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "t" });
    const now = Date.now();
    insertRun(db, { id: "r1", taskId: task.id, agent: "a", startedAt: now - 1000 });
    insertRun(db, { id: "r2", taskId: task.id, agent: "a", startedAt: now });
    const res = await agent.get("/api/activity?limit=1").expect(200);
    expect(res.body.items.length).toBe(1);
    expect(res.body.items[0].id).toBe("r2");
    expect(res.body.nextCursor).toBeTruthy();
    expect(res.body.summary.run_count).toBe(2);
  });

  it("returns taskless consolidation runs", async () => {
    const { agent, db } = makeTestServer();
    const now = Date.now();
    insertRun(db, { id: "r-consolidate", mode: "consolidate", agent: "alice", startedAt: now - 1000 });
    const res = await agent.get("/api/activity").expect(200);
    expect(res.body.items[0]).toMatchObject({
      id: "r-consolidate",
      task_id: null,
      task_title: null,
      mode: "consolidate",
      agent_name: "alice",
    });
  });

  it("summarizes filtered activity independently from pagination", async () => {
    const { agent, db } = makeTestServer();
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "costed activity" });
    const now = Date.now();
    insertRun(db, { id: "alpha-new", taskId: task.id, agent: "alpha", startedAt: now, costUsd: 0.02 });
    insertRun(db, { id: "alpha-old", taskId: task.id, agent: "alpha", startedAt: now - 1000, costUsd: 0.01 });
    insertRun(db, { id: "alpha-running", taskId: task.id, agent: "alpha", status: "running", processStatus: "running", startedAt: now - 2000 });
    insertRun(db, { id: "alpha-error", taskId: task.id, agent: "alpha", status: "error", processStatus: "failed", startedAt: now - 3000, costUsd: 0.04 });
    insertRun(db, { id: "alpha-unpriced", taskId: task.id, agent: "alpha", startedAt: now - 4000 });
    insertRun(db, { id: "beta-new", taskId: task.id, agent: "beta", startedAt: now + 1, costUsd: 0.99 });

    const res = await agent.get("/api/activity?agent=alpha&limit=1").expect(200);

    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe("alpha-new");
    expect(res.body.summary).toMatchObject({
      run_count: 5,
      costed_run_count: 3,
      unpriced_run_count: 1,
      running_count: 1,
      error_count: 1,
    });
    expect(res.body.summary.total_cost_usd).toBeCloseTo(0.07);
    expect(res.body.summary.average_cost_usd).toBeCloseTo(0.07 / 3);

    const errorRes = await agent.get("/api/activity?agent=alpha&status=error").expect(200);
    expect(errorRes.body.items.map((item) => item.id)).toEqual(["alpha-error"]);
    expect(errorRes.body.summary.run_count).toBe(1);
    expect(errorRes.body.summary.error_count).toBe(1);
  });

  it("uses agent log cost when the run row has no cost", async () => {
    const { agent, db } = makeTestServer();
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "log cost" });
    const now = Date.now();
    insertRun(db, { id: "log-cost", taskId: task.id, agent: "alpha", startedAt: now });
    insertLog(db, { id: "log-cost-log", runId: "log-cost", costUsd: 0.0123, createdAt: now });

    const res = await agent.get("/api/activity").expect(200);

    expect(res.body.items[0].cost_usd).toBeCloseTo(0.0123);
    expect(res.body.summary.costed_run_count).toBe(1);
    expect(res.body.summary.total_cost_usd).toBeCloseTo(0.0123);
  });

  it("keeps activity list rows summary-only when run payload columns are large", async () => {
    const { agent, db } = makeTestServer();
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "large activity" });
    const now = Date.now();
    const largeText = "activity payload ".repeat(5000);
    insertRun(db, { id: "large-activity", taskId: task.id, agent: "alpha", startedAt: now });
    db.prepare(`
      UPDATE task_runs
      SET result_json = ?,
          artifacts_json = ?,
          diagnostics_json = ?,
          transcript_tail_json = ?
      WHERE id = ?
    `).run(
      JSON.stringify({ final_text: largeText }),
      JSON.stringify([{ path: "src/heavy.js", content: largeText }]),
      JSON.stringify({ error_details: largeText }),
      JSON.stringify([{ role: "assistant", content: largeText }]),
      "large-activity",
    );

    const res = await agent.get("/api/activity?limit=1").expect(200);
    const item = res.body.items[0];

    expect(item.id).toBe("large-activity");
    expect(item.result_json).toBeUndefined();
    expect(item.artifacts_json).toBeUndefined();
    expect(item.diagnostics_json).toBeUndefined();
    expect(item.transcript_tail_json).toBeUndefined();
    expect(JSON.stringify(res.body).length).toBeLessThan(20_000);
  });

  it("returns day-by-day cost buckets for filtered activity", async () => {
    const { agent, db } = makeTestServer();
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "daily costs" });
    const firstDay = Date.parse("2026-04-29T00:00:00.000Z");
    const secondDay = firstDay + 24 * 60 * 60 * 1000;
    const thirdDay = secondDay + 24 * 60 * 60 * 1000;
    insertRun(db, { id: "day-one", taskId: task.id, agent: "alpha", startedAt: firstDay + 1_000, costUsd: 0.01 });
    insertRun(db, { id: "day-two-run", taskId: task.id, agent: "alpha", startedAt: secondDay + 1_000, costUsd: 0.02 });
    insertRun(db, { id: "day-two-log", taskId: task.id, agent: "alpha", startedAt: secondDay + 2_000 });
    insertLog(db, { id: "day-two-log-row", runId: "day-two-log", costUsd: 0.03, createdAt: secondDay + 2_000 });
    insertRun(db, { id: "other-agent", taskId: task.id, agent: "beta", startedAt: thirdDay + 1_000, costUsd: 0.99 });

    const res = await agent.get("/api/activity?agent=alpha&from=2026-04-29&to=2026-05-01").expect(200);

    expect(res.body.summary.cost_by_day.map((row) => ({ date: row.date, costed_run_count: row.costed_run_count }))).toEqual([
      { date: "2026-04-29", costed_run_count: 1 },
      { date: "2026-04-30", costed_run_count: 2 },
      { date: "2026-05-01", costed_run_count: 0 },
    ]);
    expect(res.body.summary.cost_by_day[0].total_cost_usd).toBeCloseTo(0.01);
    expect(res.body.summary.cost_by_day[1].total_cost_usd).toBeCloseTo(0.05);
    expect(res.body.summary.cost_by_day[2].total_cost_usd).toBe(0);
  });

  it("includes the whole day for date-only to filters", async () => {
    const { agent, db } = makeTestServer();
    const { body: { task } } = await agent.post("/api/tasks").send({ title: "dated" });
    const dayStart = Date.parse("2026-04-29T00:00:00.000Z");
    insertRun(db, { id: "early", taskId: task.id, startedAt: dayStart + 1_000, costUsd: 0.01 });
    insertRun(db, { id: "late", taskId: task.id, startedAt: dayStart + 23 * 60 * 60 * 1000, costUsd: 0.02 });
    insertRun(db, { id: "tomorrow", taskId: task.id, startedAt: dayStart + 24 * 60 * 60 * 1000, costUsd: 0.03 });

    const res = await agent.get("/api/activity?from=2026-04-29&to=2026-04-29").expect(200);

    expect(res.body.items.map((item) => item.id)).toEqual(["late", "early"]);
    expect(res.body.summary.run_count).toBe(2);
    expect(res.body.summary.total_cost_usd).toBeCloseTo(0.03);
  });
});
