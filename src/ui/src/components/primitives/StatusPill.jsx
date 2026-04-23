const STATUS_META = {
  todo: { label: "Todo", color: "var(--teal)", icon: "○" },
  in_progress: { label: "In progress", color: "var(--yellow)", icon: "◐" },
  in_review: { label: "In review", color: "var(--accent)", icon: "◉" },
  done: { label: "Done", color: "var(--green)", icon: "●" },
  error: { label: "Blocked", color: "var(--red)", icon: "▲" },
  running: { label: "Running", color: "var(--yellow)", icon: "◐" },
  complete: { label: "Complete", color: "var(--green)", icon: "●" },
  failed: { label: "Failed", color: "var(--red)", icon: "▲" },
  cancelled: { label: "Cancelled", color: "var(--muted)", icon: "◌" },
  disabled: { label: "Disabled", color: "var(--muted)", icon: "○" },
  enabled: { label: "Enabled", color: "var(--green)", icon: "●" },
};

export function statusMeta(status) {
  return STATUS_META[status] || { label: status, color: "var(--muted)", icon: "○" };
}

export function StatusPill({ status, label, size = "md", class: className = "" }) {
  const meta = statusMeta(status);
  return (
    <span
      class={`status-pill status-pill-${size} ${className}`.trim()}
      data-status={status}
      style={{ "--pill-color": meta.color }}
    >
      <span class="status-pill-icon" aria-hidden="true">{meta.icon}</span>
      <span class="status-pill-label">{label || meta.label}</span>
    </span>
  );
}

export function StatusDot({ status, pulse = false, size = 8, class: className = "" }) {
  const meta = statusMeta(status);
  if (pulse) {
    return (
      <span
        class={`status-dot-pulse ${className}`.trim()}
        style={{ "--dot-color": meta.color, "--dot-size": `${size}px` }}
        aria-hidden="true"
      >
        <span class="status-dot-ring" />
        <span class="status-dot-core" />
      </span>
    );
  }
  return (
    <span
      class={`status-dot ${className}`.trim()}
      style={{
        "--dot-color": meta.color,
        "--dot-size": `${size}px`,
        opacity: status === "done" ? 0.6 : 1,
      }}
      aria-hidden="true"
    />
  );
}
