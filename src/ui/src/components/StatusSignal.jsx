export function StatusSignal({ tone = "muted", children, label, compact = false, class: className = "" }) {
  return (
    <span class={`status-signal status-signal-${tone} ${compact ? "status-signal-compact" : ""} ${className}`}>
      <span class="status-signal-dot" aria-hidden="true" />
      <span>{children || label}</span>
    </span>
  );
}
