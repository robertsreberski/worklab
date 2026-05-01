import { describe, expect, it, vi } from "vitest";
import {
  BROWSER_NOTIFICATIONS_KEY,
  browserNotificationSettings,
  buildRunNotification,
  disableBrowserNotifications,
  maybeShowRunNotification,
  requestAndEnableBrowserNotifications,
  runNotificationRoute,
  setBrowserNotificationsEnabled,
  shouldShowRunNotification,
} from "../../ui/src/lib/browserNotifications.js";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

function notificationEnv({ permission = "default", visibilityState = "visible" } = {}) {
  const notifications = [];
  class FakeNotification {
    static permission = permission;
    static requestPermission = vi.fn(async () => {
      FakeNotification.permission = "granted";
      return "granted";
    });
    constructor(title, options) {
      this.title = title;
      this.options = options;
      notifications.push(this);
    }
  }
  return {
    Notification: FakeNotification,
    localStorage: memoryStorage(),
    document: { visibilityState },
    notifications,
    focus: vi.fn(),
  };
}

const taskStarted = {
  type: "run_started",
  runId: "run-1",
  taskId: "task-1",
  taskKey: "T-7",
  taskTitle: "Implement notifications",
  mode: "execute",
  stage: "execute",
  agentName: "coder",
  status: "running",
  processStatus: "running",
};

describe("browser notifications", () => {
  it("stores enablement per browser after permission is granted", async () => {
    const env = notificationEnv();
    expect(browserNotificationSettings(env)).toMatchObject({
      supported: true,
      permission: "default",
      enabled: false,
    });

    const settings = await requestAndEnableBrowserNotifications(env);

    expect(env.Notification.requestPermission).toHaveBeenCalledTimes(1);
    expect(settings).toMatchObject({ permission: "granted", enabled: true });
    expect(env.localStorage.getItem(BROWSER_NOTIFICATIONS_KEY)).toBe("true");
    expect(disableBrowserNotifications(env)).toMatchObject({ enabled: false });
  });

  it("builds task-only run notification content", () => {
    expect(buildRunNotification({ ...taskStarted, agentDisplayName: "Code Specialist" })).toEqual({
      kind: "started",
      title: "Run started: T-7 · Implement notifications",
      body: "Execute · Code Specialist",
    });
    expect(buildRunNotification({ ...taskStarted, taskId: null })).toBeNull();
    expect(buildRunNotification({ ...taskStarted, type: "run_ended", processStatus: "cancelled" })).toBeNull();
    expect(buildRunNotification({
      ...taskStarted,
      type: "run_ended",
      processStatus: "failed",
      errorText: "worker exited",
    })).toMatchObject({
      kind: "errored",
      title: "Run errored: T-7 · Implement notifications",
      body: "worker exited",
    });
    expect(buildRunNotification({
      ...taskStarted,
      type: "run_ended",
      status: "complete",
      processStatus: "succeeded",
    })).toMatchObject({
      kind: "completed",
      title: "Run completed: T-7 · Implement notifications",
      body: "Execute · coder",
    });
  });

  it("only shows notifications when enabled, granted, and hidden", () => {
    const env = notificationEnv({ permission: "granted", visibilityState: "visible" });
    setBrowserNotificationsEnabled(true, env);
    expect(shouldShowRunNotification(taskStarted, env)).toBe(false);

    env.document.visibilityState = "hidden";
    expect(shouldShowRunNotification(taskStarted, env)).toBe(true);
  });

  it("shows and de-dupes a browser notification", () => {
    const env = notificationEnv({ permission: "granted", visibilityState: "hidden" });
    setBrowserNotificationsEnabled(true, env);
    const onClick = vi.fn();

    const first = maybeShowRunNotification(taskStarted, { env, onClick, now: 1000 });
    const second = maybeShowRunNotification(taskStarted, { env, onClick, now: 1200 });

    expect(first.shown).toBe(true);
    expect(second).toEqual({ shown: false, reason: "duplicate" });
    expect(env.notifications).toHaveLength(1);
    expect(env.notifications[0].options.tag).toBe("worklab-run-1");

    env.notifications[0].onclick({ preventDefault: vi.fn() });
    expect(onClick).toHaveBeenCalledWith(taskStarted);
  });

  it("builds task run routes for notification clicks", () => {
    expect(runNotificationRoute(taskStarted)).toBe("#/tasks/T-7?run=run-1");
    expect(runNotificationRoute({ ...taskStarted, taskKey: "" })).toBe("#/tasks/task-1?run=run-1");
  });
});
