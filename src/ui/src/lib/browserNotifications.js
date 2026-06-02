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

export function notificationDiagnostics(env = getGlobal()) {
  const mobile = isMobileClient(env);
  const standalone = isStandalonePwa(env);
  return {
    notificationApi: browserNotificationsSupported(env),
    secure: env.isSecureContext !== false,
    mobile,
    standalone,
    serviceWorker: !!env.navigator?.serviceWorker,
    pushManager: typeof env.PushManager === "function",
  };
}

function pwaBlockingReason(diagnostics) {
  if (!diagnostics.notificationApi) return "notification_api_unavailable";
  if (!diagnostics.secure) return "insecure_context";
  if (diagnostics.mobile && !diagnostics.standalone) return "install_required";
  if (!diagnostics.serviceWorker) return "service_worker_unavailable";
  if (!diagnostics.pushManager) return "push_api_unavailable";
  return null;
}

function pwaNotificationsSupported(env = getGlobal()) {
  const diagnostics = notificationDiagnostics(env);
  return pwaBlockingReason(diagnostics) === null;
}

export function notificationDeliveryMode(env = getGlobal()) {
  const diagnostics = notificationDiagnostics(env);
  if (diagnostics.mobile) return "pwa";
  if (diagnostics.secure && diagnostics.serviceWorker && diagnostics.pushManager) return "pwa";
  return "browser";
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
  const diagnostics = notificationDiagnostics(env);
  const blockingReason = pwaBlockingReason(diagnostics);
  const supported = pwaNotificationsSupported(env);
  const permission = browserNotificationPermission(env);
  return {
    mode: "pwa",
    supported,
    permission,
    blockingReason,
    diagnostics,
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
    return { mode: "browser", ...browserNotificationSettings(env), reason: "unsupported" };
  }
  const permission = await api.requestPermission();
  setBrowserNotificationsEnabled(permission === "granted", env);
  const reason = permission === "granted"
    ? "registered"
    : permission === "denied"
      ? "permission_denied"
      : "permission_dismissed";
  return { mode: "browser", ...browserNotificationSettings(env), reason };
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
  const registered = await sw.register?.("/sw.js");
  const ready = await sw.ready;
  return ready || registered || null;
}

export async function ensureNotificationServiceWorker(env = getGlobal()) {
  const diagnostics = notificationDiagnostics(env);
  if (!diagnostics.secure || !diagnostics.serviceWorker) return null;
  try {
    return await pwaRegistration(env);
  } catch {
    return null;
  }
}

function subscriptionJson(subscription) {
  if (subscription?.toJSON) return subscription.toJSON();
  return subscription;
}

function notificationErrorMessage(error) {
  return error?.message || String(error || "unknown error");
}

function pwaEnableResult(env, reason, extra = {}) {
  return { ...pwaNotificationSettings(env), reason, ...extra };
}

async function requestAndEnablePwaNotifications({ env = getGlobal(), api } = {}) {
  const apiImpl = api || {};
  const support = pwaNotificationSettings(env);
  if (!support.supported) {
    setPwaNotificationsEnabled(false, env);
    return pwaEnableResult(env, support.blockingReason || "unsupported");
  }
  const currentPermission = browserNotificationPermission(env);
  if (currentPermission === "denied") {
    setPwaNotificationsEnabled(false, env);
    return pwaEnableResult(env, "permission_denied");
  }
  const notification = notificationApi(env);
  const permission = currentPermission === "granted" ? "granted" : await notification.requestPermission();
  if (permission !== "granted") {
    setPwaNotificationsEnabled(false, env);
    return pwaEnableResult(env, permission === "denied" ? "permission_denied" : "permission_dismissed");
  }
  let registration;
  try {
    registration = await pwaRegistration(env);
  } catch (error) {
    setPwaNotificationsEnabled(false, env);
    return pwaEnableResult(env, "subscription_failed", { error: notificationErrorMessage(error) });
  }
  if (!registration?.pushManager) {
    setPwaNotificationsEnabled(false, env);
    return pwaEnableResult(env, "subscription_failed", { error: "push manager is unavailable" });
  }
  let status;
  try {
    status = await apiImpl.getNotificationStatus?.();
  } catch (error) {
    status = { error };
  }
  const publicKey = status?.notifications?.pwa?.publicKey;
  if (!publicKey) {
    setPwaNotificationsEnabled(false, env);
    return pwaEnableResult(env, "missing_public_key", {
      error: status?.error ? notificationErrorMessage(status.error) : undefined,
      serverStatus: status,
    });
  }
  let subscription;
  try {
    subscription = await registration.pushManager.getSubscription?.();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToUint8Array(publicKey),
      });
    }
  } catch (error) {
    setPwaNotificationsEnabled(false, env);
    return pwaEnableResult(env, "subscription_failed", { error: notificationErrorMessage(error), serverStatus: status });
  }
  try {
    await apiImpl.subscribePushNotifications?.({ subscription: subscriptionJson(subscription), clientKind: "pwa" });
  } catch (error) {
    setPwaNotificationsEnabled(false, env);
    return pwaEnableResult(env, "subscription_failed", { error: notificationErrorMessage(error), serverStatus: status });
  }
  setPwaNotificationsEnabled(true, env);
  return pwaEnableResult(env, "registered", { serverStatus: status });
}

async function disablePwaNotifications({ env = getGlobal(), api } = {}) {
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
  return requestAndEnableBrowserNotifications(env);
}

export async function disableNotifications({ env = getGlobal(), api } = {}) {
  if (notificationDeliveryMode(env) === "pwa") return disablePwaNotifications({ env, api });
  return { mode: "browser", ...disableBrowserNotifications(env) };
}

function claimNotificationEvent(key, env = getGlobal(), { now = Date.now(), ttlMs = DEDUPE_TTL_MS } = {}) {
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
