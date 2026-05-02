import { describe, expect, it } from "vitest";
import { makeTestDb } from "../helpers/test-db.js";
import {
  deletePushSubscription,
  disablePushSubscription,
  listActivePushSubscriptions,
  pruneDisabledPushSubscriptions,
  upsertPushSubscription,
} from "../../core/push-notifications.js";

const sampleSubscription = {
  endpoint: "https://example.push.apple.com/3/device/sub",
  expirationTime: null,
  keys: {
    p256dh: "p256dh-key",
    auth: "auth-secret",
  },
};

describe("push notification subscriptions", () => {
  it("upserts and lists active subscriptions", () => {
    const db = makeTestDb();
    upsertPushSubscription(db, {
      subscription: sampleSubscription,
      userAgent: "Mobile Safari",
      clientKind: "pwa",
      now: 1000,
    });

    expect(listActivePushSubscriptions(db)).toEqual([
      expect.objectContaining({
        endpoint: sampleSubscription.endpoint,
        user_agent: "Mobile Safari",
        client_kind: "pwa",
        created_at: 1000,
        updated_at: 1000,
        last_seen_at: 1000,
        disabled_at: null,
        last_error: null,
        subscription: sampleSubscription,
      }),
    ]);
  });

  it("refreshes an existing disabled subscription without duplicating it", () => {
    const db = makeTestDb();
    upsertPushSubscription(db, { subscription: sampleSubscription, now: 1000 });
    disablePushSubscription(db, sampleSubscription.endpoint, { now: 1500, error: "410 Gone" });

    upsertPushSubscription(db, {
      subscription: {
        ...sampleSubscription,
        keys: { p256dh: "new-key", auth: "new-auth" },
      },
      userAgent: "Standalone",
      clientKind: "pwa",
      now: 2000,
    });

    expect(listActivePushSubscriptions(db)).toEqual([
      expect.objectContaining({
        endpoint: sampleSubscription.endpoint,
        user_agent: "Standalone",
        client_kind: "pwa",
        created_at: 1000,
        updated_at: 2000,
        last_seen_at: 2000,
        disabled_at: null,
        last_error: null,
        subscription: {
          ...sampleSubscription,
          keys: { p256dh: "new-key", auth: "new-auth" },
        },
      }),
    ]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM push_subscriptions").get().count).toBe(1);
  });

  it("rejects malformed subscriptions", () => {
    const db = makeTestDb();
    expect(() => upsertPushSubscription(db, { subscription: { endpoint: "" } })).toThrow("endpoint is required");
    expect(() => upsertPushSubscription(db, {
      subscription: { endpoint: "https://push.example/sub", keys: { p256dh: "key" } },
    })).toThrow("auth key is required");
  });

  it("deletes and prunes inactive subscriptions", () => {
    const db = makeTestDb();
    const second = { ...sampleSubscription, endpoint: "https://example.push.apple.com/3/device/second" };
    upsertPushSubscription(db, { subscription: sampleSubscription, now: 1000 });
    upsertPushSubscription(db, { subscription: second, now: 1000 });
    disablePushSubscription(db, sampleSubscription.endpoint, { now: 2000, error: "expired" });

    expect(deletePushSubscription(db, second.endpoint)).toBe(true);
    expect(pruneDisabledPushSubscriptions(db, { before: 3000 })).toBe(1);
    expect(listActivePushSubscriptions(db)).toEqual([]);
  });
});
