import {
  deletePushSubscription,
  disablePushSubscription,
  listActivePushSubscriptions,
  sendWebPushNotification,
  upsertPushSubscription,
  vapidPublicKey,
} from "../../core/index.js";

const TEST_PAYLOAD = {
  title: "Worklab test notification",
  body: "Notifications are connected.",
  tag: "worklab-test",
  data: { route: "#/settings", kind: "test" },
};

function permanentPushFailure(error) {
  const status = Number(error?.statusCode || error?.status);
  if (status === 404 || status === 410) return true;
  if (status !== 403) return false;
  const body = typeof error?.body === "string" ? error.body : "";
  try {
    return JSON.parse(body)?.reason === "BadJwtToken";
  } catch {
    return body.includes("BadJwtToken");
  }
}

function routeUnavailable(res) {
  return res.status(501).json({
    error: { code: "not_configured", message: "push notifications require a Worklab data directory" },
  });
}

export function registerNotificationRoutes(app, {
  db,
  dataDir,
  notifications = {},
} = {}) {
  app.get("/api/notifications/status", (_req, res) => {
    if (!dataDir) {
      return res.json({
        notifications: {
          pwa: { available: false, publicKey: "", activeSubscriptions: 0 },
        },
      });
    }
    try {
      res.json({
        notifications: {
          pwa: {
            available: true,
            publicKey: vapidPublicKey({ dataDir, webPush: notifications.webPush }),
            activeSubscriptions: listActivePushSubscriptions(db).length,
          },
        },
      });
    } catch (err) {
      res.status(500).json({ error: { code: "push_status_failed", message: err.message } });
    }
  });

  app.post("/api/notifications/subscriptions", (req, res) => {
    if (!dataDir) return routeUnavailable(res);
    try {
      const row = upsertPushSubscription(db, {
        subscription: req.body?.subscription || req.body,
        userAgent: req.get("user-agent") || "",
        clientKind: req.body?.clientKind || "pwa",
      });
      res.json({ subscription: { endpoint: row.endpoint, clientKind: row.client_kind } });
    } catch (err) {
      res.status(400).json({ error: { code: "validation", message: err.message } });
    }
  });

  app.delete("/api/notifications/subscriptions", (req, res) => {
    if (!dataDir) return routeUnavailable(res);
    const endpoint = req.body?.endpoint || req.body?.subscription?.endpoint || "";
    res.json({ deleted: deletePushSubscription(db, endpoint) });
  });

  app.post("/api/notifications/test", async (_req, res) => {
    if (!dataDir) return routeUnavailable(res);
    const sender = notifications.sender || sendWebPushNotification;
    let sent = 0;
    let failed = 0;
    for (const row of listActivePushSubscriptions(db)) {
      try {
        await sender({
          dataDir,
          subscription: row.subscription,
          payload: TEST_PAYLOAD,
        });
        sent += 1;
      } catch (err) {
        failed += 1;
        if (permanentPushFailure(err)) {
          disablePushSubscription(db, row.endpoint, { error: err.message || String(err) });
        }
      }
    }
    res.json({ sent, failed });
  });
}
