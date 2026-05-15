const STATUS_META = {
  plan:        { label: "Plan",        color: "var(--accent)",          icon: "◉" },
  execute:     { label: "Execute",     color: "var(--status-progress)", icon: "○" },
  review:      { label: "Review",      color: "var(--status-review)",   icon: "◆" },
  awaiting_children: { label: "Waiting", color: "var(--status-progress)", icon: "□" },
  awaiting_user: { label: "Needs input", color: "var(--status-error)",  icon: "▲" },
  done:        { label: "Done",        color: "var(--status-done)",     icon: "✓" },
  running:     { label: "Running",     color: "var(--status-progress)", icon: "●" },
  queued:      { label: "Queued",      color: "var(--status-muted)",    icon: "◌" },
  succeeded:   { label: "Succeeded",   color: "var(--status-done)",     icon: "✓" },
  complete:    { label: "Complete",    color: "var(--status-done)",     icon: "✓" },
  failed:      { label: "Failed",      color: "var(--status-error)",    icon: "▲" },
  abandoned:   { label: "Abandoned",   color: "var(--status-error)",    icon: "▲" },
  cancelled:   { label: "Cancelled",   color: "var(--status-muted)",    icon: "◌" },
  disabled:    { label: "Disabled",    color: "var(--status-muted)",    icon: "○" },
  enabled:     { label: "Enabled",     color: "var(--status-done)",     icon: "✓" },
  error:       { label: "Error",       color: "var(--status-error)",    icon: "▲" },
  blocked:     { label: "Blocked",     color: "var(--status-error)",    icon: "■" },
};

export function statusMeta(status) {
  return STATUS_META[status] || { label: status, color: "var(--status-muted)", icon: "○" };
}
