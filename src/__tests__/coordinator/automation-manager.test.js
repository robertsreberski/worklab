import { describe, expect, it } from "vitest";
import { makeTestDb } from "../helpers/test-db.js";
import { createAutomationManager } from "../../coordinator/automation-manager.js";

function stubBroker() {
  const events = [];
  return {
    events,
    broadcast: (_channel, payload) => events.push(payload),
  };
}

function seedAgent(db, name = "maintainer") {
  const now = Date.now();
  db.prepare(`
    INSERT INTO agents (name, display_name, sdk, model, created_at, updated_at)
    VALUES (?, ?, 'claude', 'claude:claude-sonnet-4-6', ?, ?)
  `).run(name, name, now, now);
}

function seedTask(db, { id = "task_1", owner = "maintainer", stage = "execute" } = {}) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO tasks (id, root_task_id, title, stage, owner_agent, created_at, updated_at)
    VALUES (?, ?, 'Scheduled task', ?, ?, ?, ?)
  `).run(id, id, stage, owner, now, now);
  return id;
}

function spawnFake() {
  return {
    pid: 456,
    cancel: () => {},
    done: Promise.resolve({ status: "complete", processStatus: "succeeded" }),
  };
}

describe("automation manager", () => {
  it("starts due automations as taskless runs and advances next_fire_at", async () => {
    const db = makeTestDb();
    const broker = stubBroker();
    const now = Date.UTC(2026, 0, 5, 9, 0, 0, 0);
    seedAgent(db);

    db.prepare(`
      INSERT INTO automations (
        id, title, instructions, agent_name, tags, trigger_json,
        enabled, next_fire_at, created_at, updated_at
      ) VALUES (?, ?, '', ?, '[]', ?, 1, ?, ?, ?)
    `).run(
      "auto_1",
      "Daily sync",
      "maintainer",
      JSON.stringify({ type: "daily", hour: 9, minute: 0 }),
      now,
      now - 10_000,
      now - 10_000,
    );

    const manager = createAutomationManager({ db, broker, spawn: spawnFake });
    const result = await manager.tick(now);

    expect(result.started).toHaveLength(1);
    const run = db.prepare("SELECT task_id, mode, agent_name FROM task_runs").get();
    const automation = db.prepare("SELECT last_fired_at, next_fire_at, last_run_id FROM automations WHERE id = 'auto_1'").get();
    const link = db.prepare("SELECT automation_id, trigger_type FROM automation_runs").get();

    expect(db.prepare("SELECT COUNT(*) AS count FROM tasks").get().count).toBe(0);
    expect(run).toMatchObject({ task_id: null, mode: "automation", agent_name: "maintainer" });
    expect(link).toMatchObject({ automation_id: "auto_1", trigger_type: "automatic" });
    expect(automation.last_fired_at).toBe(now);
    expect(automation.next_fire_at).toBeGreaterThan(now);
    expect(automation.last_run_id).toBe(result.started[0].runId);
    expect(broker.events.some((event) => event.type === "automation_triggered")).toBe(true);
    expect(db.prepare("SELECT outcome FROM automation_triggers WHERE automation_id = 'auto_1'").get()).toMatchObject({ outcome: "started" });
  });

  it("reopens a done task automation and starts a task run", async () => {
    const db = makeTestDb();
    const broker = stubBroker();
    const now = Date.UTC(2026, 0, 5, 9, 0, 0, 0);
    seedAgent(db);
    const taskId = seedTask(db, { stage: "done" });
    const watcher = {
      handleRunRequested: async (id) => {
        const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
        const runId = "run_task_auto";
        db.prepare(`
          INSERT INTO task_runs (id, task_id, mode, stage, agent_name, started_at, status, process_status)
          VALUES (?, ?, 'execute', ?, ?, ?, 'running', 'running')
        `).run(runId, id, task.stage, task.owner_agent, now);
        return { runId };
      },
      isActive: () => false,
    };
    db.prepare(`
      INSERT INTO automations (
        id, task_id, title, instructions, agent_name, tags, trigger_json,
        enabled, next_fire_at, created_at, updated_at
      ) VALUES (?, ?, ?, '', NULL, '[]', ?, 1, ?, ?, ?)
    `).run(
      "auto_task",
      taskId,
      "Scheduled task",
      JSON.stringify({ type: "daily", hour: 9, minute: 0 }),
      now,
      now - 10_000,
      now - 10_000,
    );

    const manager = createAutomationManager({ db, broker, watcher, spawn: spawnFake });
    const result = await manager.tick(now);

    expect(result.started).toMatchObject([{ automationId: "auto_task", runId: "run_task_auto", skipped: false }]);
    expect(db.prepare("SELECT stage, completed_at FROM tasks WHERE id = ?").get(taskId)).toMatchObject({ stage: "execute", completed_at: null });
    expect(db.prepare("SELECT task_id, mode FROM task_runs WHERE id = 'run_task_auto'").get()).toMatchObject({ task_id: taskId, mode: "execute" });
    expect(db.prepare("SELECT automation_id, trigger_type FROM automation_runs WHERE run_id = 'run_task_auto'").get()).toMatchObject({ automation_id: "auto_task", trigger_type: "automatic" });
    expect(db.prepare("SELECT task_id, run_id, outcome FROM automation_triggers WHERE automation_id = 'auto_task'").get()).toMatchObject({ task_id: taskId, run_id: "run_task_auto", outcome: "started" });
  });

  it("skips non-runnable task automations and advances the schedule", async () => {
    const db = makeTestDb();
    const broker = stubBroker();
    const now = Date.UTC(2026, 0, 5, 9, 0, 0, 0);
    seedAgent(db);
    const taskId = seedTask(db, { stage: "blocked" });
    const watcher = {
      handleRunRequested: async () => {
        throw new Error("should not run");
      },
      isActive: () => false,
    };
    db.prepare(`
      INSERT INTO automations (
        id, task_id, title, instructions, agent_name, tags, trigger_json,
        enabled, next_fire_at, created_at, updated_at
      ) VALUES (?, ?, ?, '', NULL, '[]', ?, 1, ?, ?, ?)
    `).run(
      "auto_blocked",
      taskId,
      "Blocked task",
      JSON.stringify({ type: "daily", hour: 9, minute: 0 }),
      now,
      now - 10_000,
      now - 10_000,
    );

    const manager = createAutomationManager({ db, broker, watcher, spawn: spawnFake });
    const result = await manager.tick(now);

    expect(result.started).toMatchObject([{ automationId: "auto_blocked", runId: null, skipped: true }]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM task_runs").get().count).toBe(0);
    expect(db.prepare("SELECT outcome, reason FROM automation_triggers WHERE automation_id = 'auto_blocked'").get()).toMatchObject({
      outcome: "skipped",
      reason: "task is blocked",
    });
    expect(db.prepare("SELECT next_fire_at FROM automations WHERE id = 'auto_blocked'").get().next_fire_at).toBeGreaterThan(now);
  });
});
