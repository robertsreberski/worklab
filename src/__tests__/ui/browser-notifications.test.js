import { describe, expect, it, vi } from "vitest";
import {
  BROWSER_NOTIFICATIONS_KEY,
  PWA_NOTIFICATIONS_KEY,
  buildRunNotification,
  browserNotificationSettings,
  disableNotifications,
  disableBrowserNotifications,
  getPwaNotificationsEnabled,
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

function notificationEnv({ permission = "default", visibilityState = "visible", notificationApi = true } = {}) {
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
    Notification: notificationApi ? FakeNotification : undefined,
    localStorage: memoryStorage(),
    document: { visibilityState },
    notifications,
    focus: vi.fn(),
  };
}

function pwaEnv({
  permission = "default",
  standalone = true,
  existingSubscription = null,
  notificationApi = true,
  pushManager = true,
  mobile = true,
} = {}) {
  const env = notificationEnv({ permission, visibilityState: "hidden", notificationApi });
  const calls = [];
  let currentSubscription = existingSubscription;
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
      subscribe: vi.fn(async () => {
        calls.push("subscribe");
        currentSubscription = subscription;
        return subscription;
      }),
      getSubscription: vi.fn(async () => {
        calls.push("getSubscription");
        return currentSubscription;
      }),
    },
  };
  if (!pushManager) delete registration.pushManager;
  env.isSecureContext = true;
  if (pushManager) env.PushManager = function PushManager() {};
  env.navigator = {
    standalone,
    maxTouchPoints: mobile ? 5 : 0,
    userAgent: mobile
      ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)"
      : "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
    serviceWorker: {
      register: vi.fn(async () => {
        calls.push("register");
        return registration;
      }),
      ready: Promise.resolve(registration),
    },
  };
  env.matchMedia = vi.fn((query) => ({ matches: standalone && query.includes("display-mode: standalone") }));
  if (env.Notification?.requestPermission) {
    env.Notification.requestPermission.mockImplementation(async () => {
      calls.push("requestPermission");
      env.Notification.permission = "granted";
      return "granted";
    });
  }
  return { env, registration, subscription, calls };
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
    env.localStorage.setItem(PWA_NOTIFICATIONS_KEY, "true");
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

  it("keeps iOS browser contexts in PWA install-required mode instead of browser denied", () => {
    const { env } = pwaEnv({ standalone: false, permission: "denied", pushManager: false });
    expect(notificationDeliveryMode(env)).toBe("pwa");
    expect(notificationSettings(env)).toMatchObject({
      mode: "pwa",
      supported: false,
      permission: "denied",
      blockingReason: "install_required",
      enabled: false,
    });
  });

  it("uses service-worker push on desktop push-capable clients without requiring standalone display", () => {
    const { env } = pwaEnv({ mobile: false, standalone: false });
    expect(notificationDeliveryMode(env)).toBe("pwa");
    expect(notificationSettings(env)).toMatchObject({
      mode: "pwa",
      supported: true,
      blockingReason: null,
    });
  });

  it("keeps mobile push-capable clients in PWA mode even when notification permission is unavailable", () => {
    const { env } = pwaEnv({ notificationApi: false });
    expect(notificationDeliveryMode(env)).toBe("pwa");
    expect(notificationSettings(env)).toMatchObject({
      mode: "pwa",
      supported: false,
      permission: "unsupported",
      diagnostics: expect.objectContaining({
        notificationApi: false,
        secure: true,
        standalone: true,
        serviceWorker: true,
        pushManager: true,
      }),
    });
  });

  it("subscribes and unsubscribes PWA push notifications", async () => {
    const { env, registration, subscription } = pwaEnv();
    const api = {
      getNotificationStatus: vi.fn(async () => ({ notifications: { pwa: { publicKey: "BEl0dA" } } })),
      subscribePushNotifications: vi.fn(async () => ({ ok: true })),
      unsubscribePushNotifications: vi.fn(async () => ({ deleted: true })),
    };

    await expect(requestAndEnableNotifications({ env, api })).resolves.toMatchObject({ mode: "pwa", enabled: true, reason: "registered" });
    expect(env.localStorage.getItem(BROWSER_NOTIFICATIONS_KEY)).not.toBe("true");
    expect(getBrowserNotificationsEnabled(env)).toBe(false);
    expect(env.localStorage.getItem(PWA_NOTIFICATIONS_KEY)).toBe("true");
    expect(getPwaNotificationsEnabled(env)).toBe(true);
    expect(env.navigator.serviceWorker.register).toHaveBeenCalledWith("/sw.js");
    expect(registration.pushManager.getSubscription).toHaveBeenCalledTimes(1);
    expect(registration.pushManager.subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    expect(api.subscribePushNotifications).toHaveBeenCalledWith({ subscription: subscription.toJSON(), clientKind: "pwa" });

    await expect(disableNotifications({ env, api })).resolves.toMatchObject({ mode: "pwa", enabled: false });
    expect(env.localStorage.getItem(BROWSER_NOTIFICATIONS_KEY)).not.toBe("true");
    expect(env.localStorage.getItem(PWA_NOTIFICATIONS_KEY)).toBe("false");
    expect(getBrowserNotificationsEnabled(env)).toBe(false);
    expect(subscription.unsubscribe).toHaveBeenCalled();
    expect(api.unsubscribePushNotifications).toHaveBeenCalledWith(subscription.endpoint);
  });

  it("reuses an existing PWA push subscription when permission is already granted", async () => {
    const existingSubscription = {
      endpoint: "https://push.example/existing",
      keys: { p256dh: "existing-key", auth: "existing-auth" },
      toJSON() {
        return { endpoint: this.endpoint, keys: this.keys };
      },
    };
    const { env, registration } = pwaEnv({ permission: "granted", existingSubscription });
    const api = {
      getNotificationStatus: vi.fn(async () => ({ notifications: { pwa: { publicKey: "BEl0dA" } } })),
      subscribePushNotifications: vi.fn(async () => ({ ok: true })),
    };

    await expect(requestAndEnableNotifications({ env, api })).resolves.toMatchObject({ mode: "pwa", enabled: true, reason: "registered" });

    expect(env.Notification.requestPermission).not.toHaveBeenCalled();
    expect(registration.pushManager.getSubscription).toHaveBeenCalledTimes(1);
    expect(registration.pushManager.subscribe).not.toHaveBeenCalled();
    expect(api.subscribePushNotifications).toHaveBeenCalledWith({ subscription: existingSubscription.toJSON(), clientKind: "pwa" });
  });

  it("requests PWA notification permission before asynchronous registration work", async () => {
    const { env, calls } = pwaEnv();
    const api = {
      getNotificationStatus: vi.fn(async () => ({ notifications: { pwa: { publicKey: "BEl0dA" } } })),
      subscribePushNotifications: vi.fn(async () => ({ ok: true })),
    };

    await expect(requestAndEnableNotifications({ env, api })).resolves.toMatchObject({ mode: "pwa", enabled: true });

    expect(calls[0]).toBe("requestPermission");
    expect(calls.indexOf("requestPermission")).toBeLessThan(calls.indexOf("register"));
  });

  it("returns actionable PWA enable reasons before registration", async () => {
    const denied = pwaEnv({ permission: "denied" });
    await expect(requestAndEnableNotifications({ env: denied.env, api: {} })).resolves.toMatchObject({
      mode: "pwa",
      enabled: false,
      reason: "permission_denied",
    });
    expect(denied.env.Notification.requestPermission).not.toHaveBeenCalled();
    expect(denied.env.navigator.serviceWorker.register).not.toHaveBeenCalled();

    const dismissed = pwaEnv();
    dismissed.env.Notification.requestPermission.mockImplementationOnce(async () => {
      dismissed.env.Notification.permission = "default";
      return "default";
    });
    await expect(requestAndEnableNotifications({ env: dismissed.env, api: {} })).resolves.toMatchObject({
      mode: "pwa",
      enabled: false,
      reason: "permission_dismissed",
    });
    expect(dismissed.env.navigator.serviceWorker.register).not.toHaveBeenCalled();

    const missingKey = pwaEnv({ permission: "granted" });
    await expect(requestAndEnableNotifications({
      env: missingKey.env,
      api: { getNotificationStatus: vi.fn(async () => ({ notifications: { pwa: { publicKey: "" } } })) },
    })).resolves.toMatchObject({
      mode: "pwa",
      enabled: false,
      reason: "missing_public_key",
    });
  });

  it("returns subscription failure details without storing the local preference", async () => {
    const { env, registration } = pwaEnv({ permission: "granted" });
    registration.pushManager.subscribe.mockRejectedValueOnce(new Error("subscribe failed"));
    const api = {
      getNotificationStatus: vi.fn(async () => ({ notifications: { pwa: { publicKey: "BEl0dA" } } })),
      subscribePushNotifications: vi.fn(async () => ({ ok: true })),
    };

    await expect(requestAndEnableNotifications({ env, api })).resolves.toMatchObject({
      mode: "pwa",
      enabled: false,
      reason: "subscription_failed",
      error: "subscribe failed",
    });
    expect(api.subscribePushNotifications).not.toHaveBeenCalled();
    expect(getBrowserNotificationsEnabled(env)).toBe(false);
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
