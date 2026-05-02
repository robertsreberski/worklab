import { describe, expect, it, vi } from "vitest";
import {
  BROWSER_NOTIFICATIONS_KEY,
  buildRunNotification,
  browserNotificationSettings,
  disableNotifications,
  disableBrowserNotifications,
  getBrowserNotificationsEnabled,
  maybeShowRunNotification,
  notificationDeliveryMode,
  notificationSettings,
  requestAndEnableNotifications,
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

function pwaEnv({ permission = "default", standalone = true } = {}) {
  const env = notificationEnv({ permission, visibilityState: "hidden" });
  const subscription = {
    endpoint: "https://push.example/sub",
    keys: { p256dh: "key", auth: "auth" },
    toJSON() {
      return { endpoint: this.endpoint, keys: this.keys };
    },
    unsubscribe: vi.fn(async () => true),
  };
  const registration = {
    pushManager: {
      subscribe: vi.fn(async () => subscription),
      getSubscription: vi.fn(async () => subscription),
    },
  };
  env.isSecureContext = true;
  env.PushManager = function PushManager() {};
  env.navigator = {
    standalone,
    maxTouchPoints: 5,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
    serviceWorker: {
      register: vi.fn(async () => registration),
      ready: Promise.resolve(registration),
    },
  };
  env.matchMedia = vi.fn((query) => ({ matches: standalone && query.includes("display-mode: standalone") }));
  return { env, registration, subscription };
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

  it("selects PWA delivery for mobile standalone clients", () => {
    const { env } = pwaEnv();
    setBrowserNotificationsEnabled(true, env);
    expect(notificationDeliveryMode(env)).toBe("pwa");
    expect(notificationSettings(env)).toMatchObject({
      mode: "pwa",
      supported: true,
      permission: "default",
      enabled: false,
    });
    env.Notification.permission = "granted";
    expect(notificationSettings(env)).toMatchObject({ enabled: true });
    expect(notificationDeliveryMode(notificationEnv())).toBe("browser");
  });

  it("keeps mobile installable contexts in PWA settings mode", () => {
    const { env } = pwaEnv({ standalone: false });
    expect(notificationDeliveryMode(env)).toBe("pwa");
    expect(notificationSettings(env)).toMatchObject({
      mode: "pwa",
      supported: false,
      enabled: false,
    });
  });

  it("subscribes and unsubscribes PWA push notifications", async () => {
    const { env, registration, subscription } = pwaEnv();
    const api = {
      getNotificationStatus: vi.fn(async () => ({ notifications: { pwa: { publicKey: "BEl0dA" } } })),
      subscribePushNotifications: vi.fn(async () => ({ ok: true })),
      unsubscribePushNotifications: vi.fn(async () => ({ deleted: true })),
    };

    await expect(requestAndEnableNotifications({ env, api })).resolves.toMatchObject({ mode: "pwa", enabled: true });
    expect(env.localStorage.getItem(BROWSER_NOTIFICATIONS_KEY)).toBe("true");
    expect(getBrowserNotificationsEnabled(env)).toBe(true);
    expect(env.navigator.serviceWorker.register).toHaveBeenCalledWith("/sw.js");
    expect(registration.pushManager.subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    expect(api.subscribePushNotifications).toHaveBeenCalledWith({ subscription: subscription.toJSON(), clientKind: "pwa" });

    await expect(disableNotifications({ env, api })).resolves.toMatchObject({ mode: "pwa", enabled: false });
    expect(env.localStorage.getItem(BROWSER_NOTIFICATIONS_KEY)).toBe("false");
    expect(getBrowserNotificationsEnabled(env)).toBe(false);
    expect(subscription.unsubscribe).toHaveBeenCalled();
    expect(api.unsubscribePushNotifications).toHaveBeenCalledWith(subscription.endpoint);
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

  it("does not show open-tab notifications in PWA push mode", () => {
    const { env } = pwaEnv({ permission: "granted" });
    setBrowserNotificationsEnabled(true, env);
    expect(shouldShowRunNotification(taskStarted, env)).toBe(false);
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
