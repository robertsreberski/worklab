function formatMode(mode) {
  if (!mode) return "Run";
  return String(mode).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDuration(ms) {
  if (ms == null) return null;
  const value = Number(ms);
  if (!Number.isFinite(value)) return null;
  if (value < 1000) return `${value}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function taskLabel(event = {}) {
  return [event.taskKey, event.taskTitle || event.taskId].filter(Boolean).join(" · ");
}

export function runNotificationKind(event = {}) {
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
  const kind = runNotificationKind(event);
  if (!kind) return null;
  const label = taskLabel(event) || "Task run";
  const phase = formatMode(event.stage || event.mode);
  const agent = (event.agentDisplayName || event.agentName) ? String(event.agentDisplayName || event.agentName) : "";
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

export function buildRunPushPayload(event = {}) {
  const notification = buildRunNotification(event);
  const route = runNotificationRoute(event);
  if (!notification || !route) return null;
  return {
    title: notification.title,
    body: notification.body,
    tag: `worklab-${event.runId || `${event.type}:${notification.kind}`}`,
    data: {
      kind: notification.kind,
      route,
      runId: event.runId || null,
      taskId: event.taskId || null,
    },
  };
}
