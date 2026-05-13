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
  if (agent?.context_window === "1m") parts.push("1M context");
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

function pathSeparator(value) {
  if (value.includes("\\") && !value.includes("/")) return "\\";
  if (value.includes("/")) return "/";
  return "";
}

function joinPathSegments(segments, separator) {
  if (segments[0] === "") return `${separator}${segments.slice(1).join(separator)}`;
  return segments.join(separator);
}

export function middleTruncatePath(value, maxChars = 56) {
  const raw = String(value || "");
  const max = Number.isFinite(maxChars) ? Math.max(12, Math.floor(maxChars)) : 56;
  if (!raw || raw.length <= max) return raw;

  const separator = pathSeparator(raw);
  if (!separator) return raw;

  const parts = raw.split(separator).filter((part, index) => part || index === 0);
  if (parts.length < 4) return raw;

  const marker = `${separator}..${separator}`;
  const isRooted = parts[0] === "" || /^[A-Za-z]:$/.test(parts[0]);
  const preferredPrefix = Math.min(parts.length - 2, isRooted ? 3 : 2);

  for (let prefixCount = preferredPrefix; prefixCount >= 1; prefixCount -= 1) {
    const prefix = joinPathSegments(parts.slice(0, prefixCount), separator);
    for (let suffixCount = parts.length - prefixCount - 1; suffixCount >= 1; suffixCount -= 1) {
      const suffix = parts.slice(parts.length - suffixCount).join(separator);
      const candidate = `${prefix}${marker}${suffix}`;
      if (candidate.length <= max) return candidate;
    }
  }

  const tailLength = Math.max(4, max - marker.length - 8);
  return `${raw.slice(0, 8)}..${raw.slice(-tailLength)}`;
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
  if (task.running_run_id) return false;
  if ((task.running_run?.process_status || task.running_run?.status) === "running") return false;
  if (Array.isArray(task.runs) && task.runs.some((run) => (run?.process_status || run?.status) === "running")) return false;
  if ((task.stage || "plan") === "done") return false;
  if (task.last_run?.status === "error" || task.last_run?.process_status === "failed" || task.last_run?.process_status === "abandoned") return true;
  if (Array.isArray(task.runs) && task.runs.length) {
    const last = task.runs[task.runs.length - 1];
    if (last?.status === "error" || last?.process_status === "failed" || last?.process_status === "abandoned") return true;
  }
  return false;
}

export function taskRecoveryState(task) {
  const recovery = task?.last_run?.recovery || null;
  if (!recovery?.active_run_id) return null;
  return recovery;
}

export function taskRecoveryLabel(task) {
  const recovery = taskRecoveryState(task);
  if (!recovery) return null;
  const stage = recovery.stage || task?.stage || task?.last_run?.stage;
  return stage === "review" ? "Retrying review" : "Auto-retrying";
}
