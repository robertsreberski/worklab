export const TASK_STATUS_LABELS = {
  plan: "Plan",
  execute: "Execute",
  review: "Review",
  awaiting_children: "Waiting",
  awaiting_user: "Needs input",
  blocked: "Blocked",
  done: "Done",
  running: "Running",
  queued: "Queued",
  succeeded: "Succeeded",
  complete: "Complete",
  failed: "Failed",
  error: "Error",
  cancelled: "Cancelled",
  abandoned: "Abandoned",
};

export const STATUS_TONES = {
  plan: "blue",
  execute: "teal",
  review: "blue",
  awaiting_children: "yellow",
  awaiting_user: "red",
  blocked: "red",
  done: "green",
  running: "yellow",
  queued: "muted",
  succeeded: "green",
  complete: "green",
  error: "red",
  failed: "red",
  abandoned: "red",
  cancelled: "muted",
  disabled: "muted",
  enabled: "green",
};

export function humanizeSlug(value) {
  return String(value || "")
    .split("-")
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

export function agentDisplayName(agents = [], name, fallback = "Unassigned") {
  if (!name) return fallback;
  const agent = agents.find((item) => item.name === name);
  return agent?.display_name || humanizeSlug(name) || name;
}

export function agentModelEffortLabel(agent) {
  const parts = [];
  if (agent?.model) parts.push(String(agent.model));
  if (agent?.effort) parts.push(`${agent.effort} effort`);
  return parts.join(" · ");
}

export function skillDisplayName(skill) {
  return skill?.display_name || skill?.meta?.display_name || humanizeSlug(skill?.name) || skill?.name || "";
}

export function modelDisplayName(value, options = []) {
  const flat = options.flatMap((item) => Array.isArray(item.options) ? item.options : [item]);
  const match = flat.find((option) => option?.value === value);
  if (match?.label) return match.label;
  const raw = String(value || "");
  if (!raw) return "";
  const parts = raw.split(":");
  return parts[parts.length - 1] || raw;
}

function includesPart(parts, value) {
  const needle = String(value || "").toLowerCase();
  return !!needle && parts.some((part) => String(part || "").toLowerCase().includes(needle));
}

export function modelOptionDescription(model = {}, group = {}) {
  const unavailable = group.available === false
    ? group.unavailable_reason || "Unavailable"
    : (model.available === false || model.disabled === true)
      ? model.unavailable_reason || "Unavailable"
      : null;
  if (unavailable) return unavailable;

  const parts = [];
  if (model.description) parts.push(model.description);
  const runtime = model.runtime_kind || model.capabilities?.runtime_kind || group.runtime_kind;
  if (runtime && !includesPart(parts, runtime)) parts.push(runtime);
  const provider = model.provider_name || model.provider || model.provider_type || group.provider || group.provider_type;
  if (provider && !includesPart(parts, provider)) parts.push(provider);
  return parts.join(" / ") || undefined;
}

export function shortDate(value) {
  if (!value) return "-";
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function taskDisplayKey(taskOrId) {
  if (taskOrId && typeof taskOrId === "object") {
    if (taskOrId.task_key) return String(taskOrId.task_key).toUpperCase();
    taskOrId = taskOrId.id;
  }
  const raw = String(taskOrId || "");
  if (!raw) return "";
  if (/^T-\d+$/i.test(raw)) return raw.toUpperCase();
  if (raw.startsWith("task_")) return raw.slice(5, 11).toUpperCase();
  return raw.slice(0, 6).toUpperCase();
}

export function taskRouteId(task) {
  if (task && typeof task === "object") {
    return encodeURIComponent(task.task_key || task.id || "");
  }
  return encodeURIComponent(String(task || ""));
}

// §5.3 — true when the task's most recent run errored. Used for warning chips;
// workflow stage display and grouping come from task.stage.
export function hasRunError(task) {
  if (!task) return false;
  if (task.last_run?.status === "error" || task.last_run?.process_status === "failed" || task.last_run?.process_status === "abandoned") return true;
  if (Array.isArray(task.runs) && task.runs.length) {
    const last = task.runs[task.runs.length - 1];
    if (last?.status === "error" || last?.process_status === "failed" || last?.process_status === "abandoned") return true;
  }
  return false;
}
