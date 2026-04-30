export const DEFAULT_RUN_POLICY = "auto_plan_execute";

export const TASK_DETAIL_SECTIONS = [
  { id: "task-brief", num: "01", label: "Brief", meta: "Request" },
  { id: "task-plan", num: "02", label: "Plan", meta: "Markdown" },
  { id: "task-workflow", num: "03", label: "Workflow", meta: "Automation" },
  { id: "task-activity", num: "04", label: "Activity", meta: "Comments & runs" },
];

export function formatDate(value) {
  return value ? new Date(value).toLocaleString() : null;
}

export function formatMetadataAge(value) {
  if (!value) return "";
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return "";
  const delta = Date.now() - timestamp;
  const abs = Math.abs(delta);
  const past = delta >= 0;
  if (abs < 60_000) return past ? "now" : "soon";
  const units = [
    ["d", 86_400_000],
    ["h", 3_600_000],
    ["m", 60_000],
  ];
  const [unit, size] = units.find(([, unitSize]) => abs >= unitSize) || units[2];
  const amount = Math.floor(abs / size);
  return past ? `${amount}${unit} ago` : `in ${amount}${unit}`;
}

function formatMetadataShortDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const options = { month: "short", day: "numeric" };
  if (date.getFullYear() !== new Date().getFullYear()) options.year = "numeric";
  return date.toLocaleDateString(undefined, options);
}

export function formatMetadataDateWithAge(value) {
  const date = formatMetadataShortDate(value);
  const age = formatMetadataAge(value);
  return [date, age].filter(Boolean).join(" · ");
}

export function formatRunPolicy(value) {
  return value === "auto_plan_execute" ? "Auto" : "Manual";
}

export function projectRouteId(project) {
  return encodeURIComponent(project?.slug || project?.id || "");
}

export function formatActivityTime(value) {
  if (!value) return "";
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return "";
  const ms = Date.now() - timestamp;
  if (ms < 60_000) return "now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  if (ms < 86_400_000 * 7) return `${Math.floor(ms / 86_400_000)}d`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
