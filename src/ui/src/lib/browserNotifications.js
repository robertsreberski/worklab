import { formatMode, formatDuration } from "./runFormatting.js";

export const BROWSER_NOTIFICATIONS_KEY = "worklab.browserNotifications.enabled";
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

export function browserNotificationSettings(env = getGlobal()) {
  const supported = browserNotificationsSupported(env);
  const permission = browserNotificationPermission(env);
  return {
    supported,
    permission,
    enabled: supported && permission === "granted" && getBrowserNotificationsEnabled(env),
  };
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

function taskLabel(event = {}) {
  return [event.taskKey, event.taskTitle || event.taskId].filter(Boolean).join(" · ");
}

function runKind(event = {}) {
  if (!event?.taskId) return null;
  if (event.type === "run_started") return "started";
  if (event.type !== "run_ended") return null;
  const status = event.processStatus || event.status;
  if (["failed", "error", "abandoned"].includes(status)) return "errored";
  if (["succeeded", "complete"].includes(status)) return "completed";
  return null;
}

export function runNotificationRoute(event = {}) {
  if (!event.taskId) return null;
  const taskRouteId = encodeURIComponent(event.taskKey || event.taskId);
  const runParam = event.runId ? `?run=${encodeURIComponent(event.runId)}` : "";
  return `#/tasks/${taskRouteId}${runParam}`;
}

export function buildRunNotification(event = {}) {
  const kind = runKind(event);
  if (!kind) return null;
  const label = taskLabel(event) || "Task run";
  const phase = formatMode(event.stage || event.mode);
  const agent = event.agentName ? String(event.agentName) : "";
  const base = [phase, agent].filter(Boolean).join(" · ");
  if (kind === "started") {
    return {
      kind,
      title: `Run started: ${label}`,
      body: base || "Agent run started.",
    };
  }
  if (kind === "completed") {
    const duration = event.startedAt && event.endedAt ? formatDuration(event.endedAt - event.startedAt) : null;
    return {
      kind,
      title: `Run completed: ${label}`,
      body: [base, duration].filter(Boolean).join(" · ") || "Agent run completed.",
    };
  }
  return {
    kind,
    title: `Run errored: ${label}`,
    body: event.errorText || event.failureKind || base || "Agent run failed.",
  };
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
