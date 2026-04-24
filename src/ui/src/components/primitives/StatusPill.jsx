// §3.11 StatusPill — sole visual carrier of state (principle 1.2).
// Label + color come from statusMeta(). Width is driven by the host cell;
// the pill truncates at the container's bounds.

const STATUS_META = {
  todo:        { label: "Todo",        color: "var(--status-todo)",     icon: "○" },
  in_progress: { label: "In progress", color: "var(--status-progress)", icon: "◐" },
  in_review:   { label: "In review",   color: "var(--status-review)",   icon: "◉" },
  done:        { label: "Done",        color: "var(--status-done)",     icon: "●" },
  running:     { label: "Running",     color: "var(--status-progress)", icon: "◐" },
  complete:    { label: "Complete",    color: "var(--status-done)",     icon: "●" },
  failed:      { label: "Failed",      color: "var(--status-error)",    icon: "▲" },
  cancelled:   { label: "Cancelled",   color: "var(--status-muted)",    icon: "◌" },
  disabled:    { label: "Disabled",    color: "var(--status-muted)",    icon: "○" },
  enabled:     { label: "Enabled",     color: "var(--status-done)",     icon: "●" },
  error:       { label: "Error",       color: "var(--status-error)",    icon: "▲" },
  blocked:     { label: "Blocked",     color: "var(--status-error)",    icon: "▲" }, // [Target]
};

export function statusMeta(status) {
  return STATUS_META[status] || { label: status, color: "var(--status-muted)", icon: "○" };
}

export function StatusPill({ status, label, size = "md", class: className = "" }) {
  const meta = statusMeta(status);
  return (
    <span
      class={`status-pill status-pill-${size} ${className}`.trim()}
      data-status={status}
      style={{ "--pill-color": meta.color }}
      title={label || meta.label}
    >
      <span class="status-pill-icon" aria-hidden="true">{meta.icon}</span>
      <span class="status-pill-label">{label || meta.label}</span>
    </span>
  );
}

// StatusDot re-exported here for call-site backwards compat; the primitive now
// lives in its own file (primitives/StatusDot.jsx) per §3.12.
export { StatusDot } from "./StatusDot.jsx";
