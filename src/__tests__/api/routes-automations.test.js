import { describe, expect, it } from "vitest";
import { makeTestServer } from "../helpers/test-server.js";
import { createAutomationManager } from "../../coordinator/automation-manager.js";

function seedAgent(db, name = "maintainer") {
  const now = Date.now();
  db.prepare(`
    INSERT INTO agents (name, display_name, sdk, model, created_at, updated_at)
    VALUES (?, ?, 'claude', 'claude:claude-sonnet-4-6', ?, ?)
  `).run(name, name, now, now);
}

function seedTask(db, { id = "task_1", title = "Scheduled task", owner = "maintainer", stage = "execute" } = {}) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO tasks (id, root_task_id, title, stage, owner_agent, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, id, title, stage, owner, now, now);
  return id;
}

function spawnFake() {
  return {
    pid: 123,
    cancel: () => {},
    done: Promise.resolve({ status: "complete", processStatus: "succeeded" }),
  };
}

describe("automations routes", () => {
  it("lists automations and returns created detail", async () => {
    const { agent, db } = makeTestServer();
    seedAgent(db);

    const runAt = Date.UTC(2026, 0, 5, 9, 30, 0, 0);
    const create = await agent.post("/api/automations").send({
      title: "One-off review",
      agent_name: "maintainer",
      trigger: { type: "once", run_at: runAt },
      enabled: true,
    }).expect(201);

    expect(create.body.automation.title).toBe("One-off review");
    expect(create.body.automation.trigger).toMatchObject({ type: "once", run_at: runAt });
    expect(create.body.automation.upcoming_fires).toEqual([runAt]);

    const list = await agent.get("/api/automations").expect(200);
    expect(list.body.automations).toHaveLength(1);
    expect(list.body.automations[0]).toMatchObject({
      id: create.body.automation.id,
      title: "One-off review",
      agent_name: "maintainer",
      enabled: true,
    });
  });

  it("manual run creates a taskless automation run", async () => {
    const holder = { current: null };
    const automationManager = {
      refresh: () => holder.current?.refresh(),
      runNow: (...args) => holder.current.runNow(...args),
      isActive: (...args) => holder.current?.isActive(...args) || false,
    };
    const { agent, db, broker } = makeTestServer({ automationManager });
    seedAgent(db);
    holder.current = createAutomationManager({ db, broker, spawn: spawnFake });

    const create = await agent.post("/api/automations").send({
      title: "Daily maintenance",
      instructions: "Clean up stale branches.",
      agent_name: "maintainer",
      trigger: { type: "daily", hour: 8, minute: 0 },
      enabled: true,
    }).expect(201);

    const run = await agent.post(`/api/automations/${create.body.automation.id}/run`).expect(201);
    expect(run.body.runId).toBeTruthy();

    const taskCount = db.prepare("SELECT COUNT(*) AS count FROM tasks").get().count;
    const runRow = db.prepare("SELECT task_id, mode, agent_name FROM task_runs WHERE id = ?").get(run.body.runId);
    const linkRow = db.prepare("SELECT automation_id, trigger_type FROM automation_runs WHERE run_id = ?").get(run.body.runId);

    expect(taskCount).toBe(0);
    expect(runRow).toMatchObject({ task_id: null, mode: "automation", agent_name: "maintainer" });
    expect(linkRow).toMatchObject({ automation_id: create.body.automation.id, trigger_type: "manual" });
  });

  it("creates task automations and marks the task summary", async () => {
    const { agent, db } = makeTestServer();
    seedAgent(db);
    const taskId = seedTask(db);

    const create = await agent.post(`/api/tasks/${taskId}/automations`).send({
      trigger: { type: "daily", hour: 7, minute: 30 },
      enabled: true,
    }).expect(201);

    expect(create.body.automation).toMatchObject({
      task_id: taskId,
      enabled: true,
      trigger: { type: "daily", hour: 7, minute: 30 },
    });

    const list = await agent.get(`/api/tasks/${taskId}/automations`).expect(200);
    expect(list.body.automations).toHaveLength(1);
    expect(list.body.automations[0].trigger_summary).toContain("Daily");

    const task = await agent.get(`/api/tasks/${taskId}`).expect(200);
    expect(task.body.task.automation_summary).toMatchObject({
      count: 1,
      enabled_count: 1,
      paused_count: 0,
    });
    expect(task.body.task.automation_summary.next_fire_at).toBeTruthy();
  });

  it("manual task automation run creates a task run and trigger audit", async () => {
    const holder = { db: null };
    const watcher = {
      handleRunRequested: async (taskId) => {
        const task = holder.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
        const runId = "run_task_auto";
        holder.db.prepare(`
          INSERT INTO task_runs (id, task_id, mode, stage, agent_name, started_at, status, process_status)
          VALUES (?, ?, 'execute', ?, ?, ?, 'running', 'running')
        `).run(runId, taskId, task.stage, task.owner_agent, Date.now());
        return { runId };
      },
      isActive: () => false,
      maybeAutoStart: () => {},
      maybeAutoStartDependents: () => {},
      cancel: () => false,
      shutdown: async () => {},
    };
    const automationHolder = { current: null };
    const automationManager = {
      refresh: () => automationHolder.current?.refresh(),
      runNow: (...args) => automationHolder.current.runNow(...args),
      isActive: (...args) => automationHolder.current?.isActive(...args) || false,
    };
    const { agent, db, broker } = makeTestServer({ watcher, automationManager });
    holder.db = db;
    seedAgent(db);
    const taskId = seedTask(db);
    automationHolder.current = createAutomationManager({ db, broker, watcher, spawn: spawnFake });

    const create = await agent.post(`/api/tasks/${taskId}/automations`).send({
      trigger: { type: "daily", hour: 8, minute: 0 },
      enabled: true,
    }).expect(201);
    const run = await agent.post(`/api/tasks/${taskId}/automations/${create.body.automation.id}/run`).expect(201);

    expect(run.body.runId).toBe("run_task_auto");
    const runRow = db.prepare("SELECT task_id, mode FROM task_runs WHERE id = ?").get(run.body.runId);
    const linkRow = db.prepare("SELECT automation_id, trigger_type FROM automation_runs WHERE run_id = ?").get(run.body.runId);
    const triggerRow = db.prepare("SELECT task_id, run_id, outcome FROM automation_triggers WHERE automation_id = ?").get(create.body.automation.id);
    expect(runRow).toMatchObject({ task_id: taskId, mode: "execute" });
    expect(linkRow).toMatchObject({ automation_id: create.body.automation.id, trigger_type: "manual" });
    expect(triggerRow).toMatchObject({ task_id: taskId, run_id: run.body.runId, outcome: "started" });
  });
});
