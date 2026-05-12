import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { doctor } from "../../cli/doctor.js";
import { collectPerformanceReport } from "../../cli/performance-doctor.js";
import { openDb } from "../../core/db/open.js";
import { runMigrations } from "../../core/db/migrations/runner.js";

function createDataDir() {
  return mkdtempSync(join(tmpdir(), "worklab-doctor-performance-"));
}

function seedLargeLog(dataDir) {
  const db = openDb(join(dataDir, "worklab.db"));
  runMigrations(db);
  const now = Date.now();
  db.prepare(`
    INSERT INTO tasks (id, task_key, root_task_id, title, instructions, stage, run_policy, created_at, updated_at)
    VALUES ('task-1', 'T-1', 'task-1', 'Perf task', '', 'done', 'manual', ?, ?)
  `).run(now, now);
  db.prepare(`
    INSERT INTO task_runs (id, task_id, mode, stage, agent_name, started_at, ended_at, status, process_status)
    VALUES ('run-large', 'task-1', 'execute', 'execute', 'alpha', ?, ?, 'complete', 'succeeded')
  `).run(now - 1000, now);
  db.prepare(`
    INSERT INTO agent_logs (id, task_run_id, events, status, created_at)
    VALUES ('log-large', 'run-large', ?, 'complete', ?)
  `).run(JSON.stringify([{ type: "tool_result", content: "large event ".repeat(20_000) }]), now);
  db.close();
}

describe("doctor performance", () => {
  const dirs = [];
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("collects database size, largest objects, largest logs, endpoints, and warnings", async () => {
    const dataDir = createDataDir();
    dirs.push(dataDir);
    seedLargeLog(dataDir);

    const report = await collectPerformanceReport({
      config: { dataDir, host: "127.0.0.1", port: 7878 },
      endpointPaths: ["/api/activity?limit=50"],
      fetchImpl: async () => new Response("x".repeat(300_000), { status: 200 }),
      budgets: { endpointBytesWarn: 250_000, agentLogsBytesWarn: 1, eventBlobBytesWarn: 1 },
    });

    expect(report.database.file_bytes).toBeGreaterThan(0);
    expect(report.database.largest_objects.some((row) => row.name === "agent_logs")).toBe(true);
    expect(report.database.largest_agent_logs[0]).toMatchObject({ task_run_id: "run-large" });
    expect(report.endpoints[0]).toMatchObject({
      path: "/api/activity?limit=50",
      status: 200,
      response_bytes: 300_000,
    });
    expect(report.warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/agent_logs/i),
      expect.stringMatching(/event log/i),
      expect.stringMatching(/payload/i),
    ]));
  });

  it("prints JSON for worklab doctor performance --json without running the normal doctor checks", async () => {
    const dataDir = createDataDir();
    dirs.push(dataDir);
    seedLargeLog(dataDir);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("", { status: 503 });

    try {
      await doctor(["performance", "--data-dir", dataDir, "--json"]);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const printed = JSON.parse(log.mock.calls[0][0]);
    expect(printed.database.path).toBe(join(dataDir, "worklab.db"));
    expect(printed.database.largest_agent_logs[0].task_run_id).toBe("run-large");
  });
});
