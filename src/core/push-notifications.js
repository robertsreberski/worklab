import { newPushSubscriptionId } from "./ids.js";

function nowMs(now = Date.now()) {
  const value = Number(now);
  return Number.isFinite(value) ? value : Date.now();
}

function cleanText(value) {
  return String(value || "").trim();
}

export function normalizePushSubscription(subscription = {}) {
  const endpoint = cleanText(subscription.endpoint);
  if (!endpoint) throw new Error("endpoint is required");
  const keys = subscription.keys && typeof subscription.keys === "object" ? subscription.keys : {};
  const p256dh = cleanText(keys.p256dh);
  const auth = cleanText(keys.auth);
  if (!p256dh) throw new Error("p256dh key is required");
  if (!auth) throw new Error("auth key is required");
  const expirationTime = subscription.expirationTime == null ? null : Number(subscription.expirationTime);
  return {
    endpoint,
    expirationTime: Number.isFinite(expirationTime) ? expirationTime : null,
    keys: { p256dh, auth },
  };
}

function rowToSubscription(row) {
  let keys = {};
  try {
    keys = JSON.parse(row.keys_json || "{}");
  } catch {
    keys = {};
  }
  return {
    endpoint: row.endpoint,
    expirationTime: row.expiration_time ?? null,
    keys,
  };
}

export function pushSubscriptionFromRow(row) {
  if (!row) return null;
  return {
    ...row,
    subscription: rowToSubscription(row),
  };
}

export function upsertPushSubscription(db, {
  subscription,
  userAgent = "",
  clientKind = "pwa",
  now = Date.now(),
} = {}) {
  const normalized = normalizePushSubscription(subscription);
  const timestamp = nowMs(now);
  const existing = db.prepare("SELECT id, created_at FROM push_subscriptions WHERE endpoint = ?").get(normalized.endpoint);
  const id = existing?.id || newPushSubscriptionId();
  db.prepare(`
    INSERT INTO push_subscriptions (
      id, endpoint, keys_json, expiration_time, user_agent, client_kind,
      created_at, updated_at, last_seen_at, disabled_at, last_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
    ON CONFLICT(endpoint) DO UPDATE SET
      keys_json = excluded.keys_json,
      expiration_time = excluded.expiration_time,
      user_agent = excluded.user_agent,
      client_kind = excluded.client_kind,
      updated_at = excluded.updated_at,
      last_seen_at = excluded.last_seen_at,
      disabled_at = NULL,
      last_error = NULL
  `).run(
    id,
    normalized.endpoint,
    JSON.stringify(normalized.keys),
    normalized.expirationTime,
    cleanText(userAgent),
    cleanText(clientKind) || "pwa",
    existing?.created_at || timestamp,
    timestamp,
    timestamp,
  );
  return pushSubscriptionFromRow(db.prepare("SELECT * FROM push_subscriptions WHERE endpoint = ?").get(normalized.endpoint));
}

export function listActivePushSubscriptions(db) {
  return db.prepare(`
    SELECT * FROM push_subscriptions
    WHERE disabled_at IS NULL
    ORDER BY last_seen_at DESC, created_at DESC
  `).all().map(pushSubscriptionFromRow);
}

export function disablePushSubscription(db, endpoint, { now = Date.now(), error = "" } = {}) {
  const result = db.prepare(`
    UPDATE push_subscriptions
    SET disabled_at = ?, updated_at = ?, last_error = ?
    WHERE endpoint = ?
  `).run(nowMs(now), nowMs(now), cleanText(error), cleanText(endpoint));
  return result.changes > 0;
}

export function deletePushSubscription(db, endpoint) {
  const result = db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(cleanText(endpoint));
  return result.changes > 0;
}

export function pruneDisabledPushSubscriptions(db, { before = Date.now() } = {}) {
  const result = db.prepare("DELETE FROM push_subscriptions WHERE disabled_at IS NOT NULL AND disabled_at <= ?").run(nowMs(before));
  return result.changes;
}
