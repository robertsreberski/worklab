import { describe, expect, it, vi } from "vitest";
import { installNotificationHandlers } from "../../ui/src/service-worker/notifications.js";

function responseJson(value) {
  return { ok: true, json: vi.fn(async () => value) };
}

function setupServiceWorker({ fetchImpl } = {}) {
  const listeners = {};
  const showNotification = vi.fn(async () => {});
  const subscription = {
    endpoint: "https://push.example/new",
    keys: { p256dh: "new-key", auth: "new-auth" },
    toJSON() {
      return { endpoint: this.endpoint, keys: this.keys };
    },
  };
  const self = {
    location: { origin: "http://127.0.0.1:7878" },
    addEventListener: (type, handler) => {
      listeners[type] = handler;
    },
    registration: {
      showNotification,
      pushManager: {
        subscribe: vi.fn(async () => subscription),
      },
    },
    clients: {
      matchAll: vi.fn(async () => []),
      openWindow: vi.fn(async () => null),
    },
  };
  installNotificationHandlers(self, { fetch: fetchImpl || vi.fn(async () => responseJson({})) });
  return { listeners, self, subscription };
}

describe("service worker notifications", () => {
  it("shows pushed notifications with payload data", async () => {
    const { listeners, self } = setupServiceWorker();
    let pending;
    listeners.push({
      data: {
        json: () => ({
          title: "Run completed",
          body: "Execute",
          tag: "worklab-run-1",
          data: { route: "#/tasks/T-1?run=run-1" },
        }),
      },
      waitUntil: (promise) => { pending = promise; },
    });

    await pending;

    expect(self.registration.showNotification).toHaveBeenCalledWith("Run completed", {
      body: "Execute",
      tag: "worklab-run-1",
      data: { route: "#/tasks/T-1?run=run-1" },
    });
  });

  it("refreshes server registration when the push subscription changes", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (url === "/api/notifications/status") {
        return responseJson({ notifications: { pwa: { publicKey: "BEl0dA" } } });
      }
      return responseJson({ ok: true });
    });
    const { listeners, subscription, self } = setupServiceWorker({ fetchImpl });
    let pending;

    listeners.pushsubscriptionchange({
      oldSubscription: { endpoint: "https://push.example/old" },
      newSubscription: null,
      waitUntil: (promise) => { pending = promise; },
    });

    await pending;

    expect(fetchImpl).toHaveBeenCalledWith("/api/notifications/subscriptions", expect.objectContaining({
      method: "DELETE",
      body: JSON.stringify({ endpoint: "https://push.example/old" }),
    }));
    expect(self.registration.pushManager.subscribe).toHaveBeenCalledWith(expect.objectContaining({
      userVisibleOnly: true,
      applicationServerKey: expect.any(Uint8Array),
    }));
    expect(fetchImpl).toHaveBeenCalledWith("/api/notifications/subscriptions", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ subscription: subscription.toJSON(), clientKind: "pwa" }),
    }));
  });
});
