import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestServer } from "../helpers/test-server.js";

const subscription = {
  endpoint: "https://push.example/sub",
  keys: { p256dh: "key", auth: "auth" },
};

describe("notification routes", () => {
  const dirs = [];

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
  });

  function server(overrides = {}) {
    const dataDir = mkdtempSync(join(tmpdir(), "worklab-notifications-"));
    dirs.push(dataDir);
    return makeTestServer({ dataDir, ...overrides });
  }

  it("reports push status with a VAPID public key", async () => {
    const { agent } = server();

    const res = await agent.get("/api/notifications/status").expect(200);

    expect(res.body.notifications.pwa).toMatchObject({
      available: true,
      activeSubscriptions: 0,
    });
    expect(res.body.notifications.pwa.publicKey).toEqual(expect.any(String));
  });

  it("subscribes and unsubscribes a PWA push endpoint", async () => {
    const { agent, db } = server();

    await agent.post("/api/notifications/subscriptions")
      .set("user-agent", "Mobile Safari")
      .send({ subscription, clientKind: "pwa" })
      .expect(200);

    expect(db.prepare("SELECT endpoint, user_agent, client_kind FROM push_subscriptions").get()).toEqual({
      endpoint: subscription.endpoint,
      user_agent: "Mobile Safari",
      client_kind: "pwa",
    });

    const res = await agent.delete("/api/notifications/subscriptions").send({ endpoint: subscription.endpoint }).expect(200);
    expect(res.body).toEqual({ deleted: true });
    expect(db.prepare("SELECT COUNT(*) AS count FROM push_subscriptions").get().count).toBe(0);
  });

  it("rejects malformed subscriptions", async () => {
    const { agent } = server();
    const res = await agent.post("/api/notifications/subscriptions")
      .send({ subscription: { endpoint: "https://push.example/sub", keys: { p256dh: "key" } } })
      .expect(400);
    expect(res.body.error.message).toContain("auth key is required");
  });

  it("sends a test push to active subscriptions", async () => {
    const sender = vi.fn(async () => ({ statusCode: 201 }));
    const { agent } = server({ notifications: { sender } });
    await agent.post("/api/notifications/subscriptions").send({ subscription }).expect(200);

    const res = await agent.post("/api/notifications/test").expect(200);

    expect(res.body).toEqual({ sent: 1, failed: 0 });
    expect(sender).toHaveBeenCalledWith(expect.objectContaining({
      subscription: expect.objectContaining(subscription),
      payload: {
        title: "Worklab test notification",
        body: "Notifications are connected.",
        tag: "worklab-test",
        data: { route: "#/settings", kind: "test" },
      },
    }));
  });

  it("disables subscriptions after APNs BadJwtToken test push failures", async () => {
    const error = Object.assign(new Error("Received unexpected response code"), {
      statusCode: 403,
      body: "{\"reason\":\"BadJwtToken\"}",
    });
    const sender = vi.fn(async () => { throw error; });
    const { agent, db } = server({ notifications: { sender } });
    await agent.post("/api/notifications/subscriptions").send({ subscription }).expect(200);

    const res = await agent.post("/api/notifications/test").expect(200);

    expect(res.body).toEqual({ sent: 0, failed: 1 });
    expect(db.prepare("SELECT disabled_at, last_error FROM push_subscriptions WHERE endpoint = ?").get(subscription.endpoint)).toMatchObject({
      disabled_at: expect.any(Number),
      last_error: "Received unexpected response code",
    });
  });
});
