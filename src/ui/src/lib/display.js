export const TASK_STATUS_LABELS = {
  todo: "To do",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
};

export const STATUS_TONES = {
  todo: "teal",
  in_progress: "yellow",
  in_review: "blue",
  done: "green",
  running: "yellow",
  complete: "green",
  error: "red",
  failed: "red",
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

export function shortDate(value) {
  if (!value) return "-";
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// §5.3 — true when the task's most recent run errored. Used by Commander
// (to put the row in the Blocked group) and TaskDetail (error chip on hero).
export function hasRunError(task) {
  if (!task) return false;
  if (task.last_run?.status === "error") return true;
  if (Array.isArray(task.runs) && task.runs.length) {
    const last = task.runs[task.runs.length - 1];
    if (last?.status === "error") return true;
  }
  return false;
}
