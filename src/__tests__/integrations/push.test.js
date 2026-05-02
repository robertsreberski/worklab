import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { makeTestDb } from "../helpers/test-db.js";
import { upsertPushSubscription } from "../../core/push-notifications.js";
import { createWorklabPushNotificationService } from "../../integrations/push/service.js";

const subscription = {
  endpoint: "https://push.example/sub",
  keys: { p256dh: "key", auth: "auth" },
};

function seedTaskRun(db, { runId = "run-1", processStatus = "running", status = "running" } = {}) {
  const now = Date.now();
  db.prepare(
    "INSERT INTO agents (name, display_name, sdk, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("coder", "Code Specialist", "claude", "claude:claude-sonnet-4-6", now, now);
  db.prepare(`
    INSERT INTO tasks (id, task_key, root_task_id, title, stage, owner_agent, created_at, updated_at)
    VALUES ('task-1', 'T-7', 'task-1', 'Implement notifications', 'execute', 'coder', ?, ?)
  `).run(now, now);
  db.prepare(`
    INSERT INTO task_runs (id, task_id, mode, stage, agent_name, status, process_status, started_at, ended_at)
    VALUES (?, 'task-1', 'execute', 'execute', 'coder', ?, ?, ?, ?)
  `).run(runId, status, processStatus, now - 1000, processStatus === "running" ? null : now);
}

describe("push notification service", () => {
  it("sends started and ended task-run pushes to active PWA subscriptions", async () => {
    const db = makeTestDb();
    seedTaskRun(db);
    upsertPushSubscription(db, { subscription, now: 1000 });
    const sender = vi.fn(async () => ({ statusCode: 201 }));
    const events = new EventEmitter();
    createWorklabPushNotificationService({ db, dataDir: "/tmp/worklab-test", events, sender }).start();

    events.emit("run:started", {
      type: "run_started",
      runId: "run-1",
      taskId: "task-1",
      taskKey: "T-7",
      taskTitle: "Implement notifications",
      stage: "execute",
      agentDisplayName: "Code Specialist",
      processStatus: "running",
    });
    events.emit("run:ended", {
      type: "run_ended",
      runId: "run-1",
      taskId: "task-1",
      taskKey: "T-7",
      taskTitle: "Implement notifications",
      stage: "execute",
      agentDisplayName: "Code Specialist",
      processStatus: "succeeded",
      startedAt: 1000,
      endedAt: 2500,
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(sender).toHaveBeenCalledTimes(2);
    expect(sender.mock.calls[0][0]).toMatchObject({
      dataDir: "/tmp/worklab-test",
      subscription,
      payload: {
        title: "Run started: T-7 · Implement notifications",
        tag: "worklab-run-1",
        data: { kind: "started", route: "#/tasks/T-7?run=run-1" },
      },
    });
    expect(sender.mock.calls[1][0].payload).toMatchObject({
      title: "Run completed: T-7 · Implement notifications",
      data: { kind: "completed" },
    });
  });

  it("dedupes repeated events and ignores taskless/cancelled runs", async () => {
    const db = makeTestDb();
    seedTaskRun(db);
    upsertPushSubscription(db, { subscription, now: 1000 });
    const sender = vi.fn(async () => ({ statusCode: 201 }));
    const service = createWorklabPushNotificationService({ db, dataDir: "/tmp/worklab-test", sender });

    await service.notifyRunLifecycle({
      type: "run_ended",
      runId: "run-1",
      taskId: "task-1",
      processStatus: "succeeded",
    });
    await service.notifyRunLifecycle({
      type: "run_ended",
      runId: "run-1",
      taskId: "task-1",
      processStatus: "succeeded",
    });
    await service.notifyRunLifecycle({ type: "run_started", runId: "automation-1", taskId: null });
    await service.notifyRunLifecycle({
      type: "run_ended",
      runId: "run-2",
      taskId: "task-1",
      processStatus: "cancelled",
    });

    expect(sender).toHaveBeenCalledTimes(1);
  });

  it("disables subscriptions after permanent push failures", async () => {
    const db = makeTestDb();
    seedTaskRun(db);
    upsertPushSubscription(db, { subscription, now: 1000 });
    const error = Object.assign(new Error("gone"), { statusCode: 410 });
    const sender = vi.fn(async () => { throw error; });
    const service = createWorklabPushNotificationService({ db, dataDir: "/tmp/worklab-test", sender, now: () => 2000 });

    await service.notifyRunLifecycle({
      type: "run_started",
      runId: "run-1",
      taskId: "task-1",
      processStatus: "running",
    });

    expect(db.prepare("SELECT disabled_at, last_error FROM push_subscriptions WHERE endpoint = ?").get(subscription.endpoint)).toEqual({
      disabled_at: 2000,
      last_error: "gone",
    });
  });
});
