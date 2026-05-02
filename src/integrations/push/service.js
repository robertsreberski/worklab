import {
  buildRunPushPayload,
  disablePushSubscription,
  listActivePushSubscriptions,
  sendWebPushNotification,
} from "../../core/index.js";

function permanentPushFailure(error) {
  const status = Number(error?.statusCode || error?.status);
  return status === 404 || status === 410;
}

export class WorklabPushNotificationService {
  constructor({
    db,
    dataDir,
    events,
    logger,
    sender = sendWebPushNotification,
    now = Date.now,
  } = {}) {
    this.db = db;
    this.dataDir = dataDir;
    this.events = events;
    this.logger = logger;
    this.sender = sender;
    this.now = now;
    this.sent = new Set();
    this.onRunStarted = (event) => {
      this.notifyRunLifecycle(event).catch((err) => {
        this.logger?.warn?.({ err, runId: event?.runId }, "push notification failed");
      });
    };
    this.onRunEnded = this.onRunStarted;
  }

  start() {
    this.events?.on?.("run:started", this.onRunStarted);
    this.events?.on?.("run:ended", this.onRunEnded);
    return this;
  }

  stop() {
    this.events?.off?.("run:started", this.onRunStarted);
    this.events?.off?.("run:ended", this.onRunEnded);
  }

  async notifyRunLifecycle(event) {
    const payload = buildRunPushPayload(event);
    if (!payload || !this.db || !this.dataDir) return { sent: 0, skipped: true };
    const dedupeKey = `${event.runId || ""}:${payload.data.kind}`;
    if (this.sent.has(dedupeKey)) return { sent: 0, skipped: true, reason: "duplicate" };
    this.sent.add(dedupeKey);

    let sent = 0;
    for (const row of listActivePushSubscriptions(this.db)) {
      try {
        await this.sender({
          dataDir: this.dataDir,
          subscription: row.subscription,
          payload,
        });
        sent += 1;
      } catch (err) {
        if (permanentPushFailure(err)) {
          disablePushSubscription(this.db, row.endpoint, {
            now: this.now(),
            error: err.message || String(err),
          });
          continue;
        }
        this.logger?.warn?.({ err, endpoint: row.endpoint }, "push notification delivery failed");
      }
    }
    return { sent };
  }
}

export function createWorklabPushNotificationService(options) {
  return new WorklabPushNotificationService(options);
}
