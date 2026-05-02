import {
  buildRunNotification,
  runNotificationRoute,
} from "../../../core/run-notifications.js";

export { buildRunNotification, runNotificationRoute };

export const BROWSER_NOTIFICATIONS_KEY = "worklab.browserNotifications.enabled";
export const PWA_NOTIFICATIONS_KEY = "worklab.pwaNotifications.enabled";
const DEDUPE_KEY_PREFIX = "worklab.browserNotifications.sent.";
const DEDUPE_TTL_MS = 5000;

function getGlobal() {
  return typeof globalThis === "object" ? globalThis : {};
}

function safeStorage(env = getGlobal()) {
  try {
    return env.localStorage || null;
  } catch {
    return null;
  }
}

function notificationApi(env = getGlobal()) {
  return env.Notification || null;
}

export function browserNotificationsSupported(env = getGlobal()) {
  return typeof notificationApi(env) === "function";
}

export function browserNotificationPermission(env = getGlobal()) {
  const api = notificationApi(env);
  if (!api) return "unsupported";
  return api.permission || "default";
}

export function getBrowserNotificationsEnabled(env = getGlobal()) {
  return safeStorage(env)?.getItem(BROWSER_NOTIFICATIONS_KEY) === "true";
}

export function setBrowserNotificationsEnabled(enabled, env = getGlobal()) {
  const storage = safeStorage(env);
  if (!storage) return false;
  storage.setItem(BROWSER_NOTIFICATIONS_KEY, enabled ? "true" : "false");
  return enabled;
}

export function getPwaNotificationsEnabled(env = getGlobal()) {
  return safeStorage(env)?.getItem(PWA_NOTIFICATIONS_KEY) === "true";
}

export function setPwaNotificationsEnabled(enabled, env = getGlobal()) {
  const storage = safeStorage(env);
  if (!storage) return false;
  storage.setItem(PWA_NOTIFICATIONS_KEY, enabled ? "true" : "false");
  return enabled;
}

function isStandalonePwa(env = getGlobal()) {
  try {
    if (env.matchMedia?.("(display-mode: standalone)")?.matches) return true;
  } catch {
    // Fall through to iOS legacy signal.
  }
  return env.navigator?.standalone === true;
}

function isMobileClient(env = getGlobal()) {
  const ua = String(env.navigator?.userAgent || "");
  if (/iPhone|iPad|iPod|Android/i.test(ua)) return true;
  const touchPoints = Number(env.navigator?.maxTouchPoints || 0);
  const width = Number(env.innerWidth || env.screen?.width || 0);
  return touchPoints > 1 && (!width || width <= 1024);
}

export function pwaNotificationsSupported(env = getGlobal()) {
  return Boolean(
    browserNotificationsSupported(env)
    && env.isSecureContext !== false
    && isMobileClient(env)
    && isStandalonePwa(env)
    && env.navigator?.serviceWorker
    && typeof env.PushManager === "function",
  );
}

export function notificationDeliveryMode(env = getGlobal()) {
  return pwaNotificationsSupported(env) ? "pwa" : "browser";
}

export function browserNotificationSettings(env = getGlobal()) {
  const supported = browserNotificationsSupported(env);
  const permission = browserNotificationPermission(env);
  return {
    supported,
    permission,
    enabled: supported && permission === "granted" && getBrowserNotificationsEnabled(env),
  };
}

export function pwaNotificationSettings(env = getGlobal()) {
  const supported = pwaNotificationsSupported(env);
  const permission = browserNotificationPermission(env);
  return {
    mode: "pwa",
    supported,
    permission,
    enabled: supported && permission === "granted" && getPwaNotificationsEnabled(env),
  };
}

export function notificationSettings(env = getGlobal()) {
  if (notificationDeliveryMode(env) === "pwa") return pwaNotificationSettings(env);
  return { mode: "browser", ...browserNotificationSettings(env) };
}

export async function requestAndEnableBrowserNotifications(env = getGlobal()) {
  const api = notificationApi(env);
  if (!api?.requestPermission) {
    setBrowserNotificationsEnabled(false, env);
    return browserNotificationSettings(env);
  }
  const permission = await api.requestPermission();
  setBrowserNotificationsEnabled(permission === "granted", env);
  return browserNotificationSettings(env);
}

export function disableBrowserNotifications(env = getGlobal()) {
  setBrowserNotificationsEnabled(false, env);
  return browserNotificationSettings(env);
}

function base64UrlToUint8Array(value) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = `${value}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
}

async function pwaRegistration(env = getGlobal()) {
  const sw = env.navigator?.serviceWorker;
  if (!sw) throw new Error("service workers are unavailable");
  await sw.register?.("/sw.js");
  return sw.ready || null;
}

function subscriptionJson(subscription) {
  if (subscription?.toJSON) return subscription.toJSON();
  return subscription;
}

export async function requestAndEnablePwaNotifications({ env = getGlobal(), api } = {}) {
  const apiImpl = api || {};
  if (!pwaNotificationsSupported(env)) {
    setPwaNotificationsEnabled(false, env);
    return pwaNotificationSettings(env);
  }
  const notification = notificationApi(env);
  const permission = await notification.requestPermission();
  if (permission !== "granted") {
    setPwaNotificationsEnabled(false, env);
    return pwaNotificationSettings(env);
  }
  const status = await apiImpl.getNotificationStatus?.();
  const publicKey = status?.notifications?.pwa?.publicKey;
  if (!publicKey) throw new Error("push server key is unavailable");
  const registration = await pwaRegistration(env);
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64UrlToUint8Array(publicKey),
  });
  await apiImpl.subscribePushNotifications?.({ subscription: subscriptionJson(subscription), clientKind: "pwa" });
  setPwaNotificationsEnabled(true, env);
  return pwaNotificationSettings(env);
}

export async function disablePwaNotifications({ env = getGlobal(), api } = {}) {
  const apiImpl = api || {};
  const registration = await pwaRegistration(env).catch(() => null);
  const subscription = await registration?.pushManager?.getSubscription?.();
  if (subscription?.endpoint) {
    await apiImpl.unsubscribePushNotifications?.(subscription.endpoint);
    await subscription.unsubscribe?.();
  }
  setPwaNotificationsEnabled(false, env);
  return pwaNotificationSettings(env);
}

export async function requestAndEnableNotifications({ env = getGlobal(), api } = {}) {
  if (notificationDeliveryMode(env) === "pwa") return requestAndEnablePwaNotifications({ env, api });
  return { mode: "browser", ...(await requestAndEnableBrowserNotifications(env)) };
}

export async function disableNotifications({ env = getGlobal(), api } = {}) {
  if (notificationDeliveryMode(env) === "pwa") return disablePwaNotifications({ env, api });
  return { mode: "browser", ...disableBrowserNotifications(env) };
}

export function claimNotificationEvent(key, env = getGlobal(), { now = Date.now(), ttlMs = DEDUPE_TTL_MS } = {}) {
  const storage = safeStorage(env);
  if (!storage || !key) return true;
  const storageKey = `${DEDUPE_KEY_PREFIX}${key}`;
  const previous = Number(storage.getItem(storageKey));
  if (Number.isFinite(previous) && previous > 0 && now - previous < ttlMs) return false;
  storage.setItem(storageKey, String(now));
  return true;
}

export function shouldShowRunNotification(event, env = getGlobal()) {
  if (!buildRunNotification(event)) return false;
  if (notificationDeliveryMode(env) === "pwa") return false;
  const settings = browserNotificationSettings(env);
  if (!settings.enabled) return false;
  if (env.document?.visibilityState !== "hidden") return false;
  return true;
}

export function maybeShowRunNotification(event, {
  env = getGlobal(),
  onClick,
  now = Date.now(),
} = {}) {
  const notification = buildRunNotification(event);
  if (!notification || !shouldShowRunNotification(event, env)) {
    return { shown: false, reason: "filtered" };
  }
  const dedupeKey = `${event.type}:${event.runId || ""}:${notification.kind}`;
  if (!claimNotificationEvent(dedupeKey, env, { now })) {
    return { shown: false, reason: "duplicate" };
  }
  const api = notificationApi(env);
  let instance;
  try {
    instance = new api(notification.title, {
      body: notification.body,
      tag: `worklab-${event.runId || dedupeKey}`,
    });
  } catch (error) {
    return { shown: false, reason: "error", error };
  }
  if (onClick) {
    instance.onclick = (clickEvent) => {
      clickEvent?.preventDefault?.();
      onClick(event);
    };
  }
  return { shown: true, notification: instance };
}
