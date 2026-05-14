// §3.11 StatusPill — sole visual carrier of state (principle 1.2).
// Label + color come from statusMeta(). Width is driven by the host cell;
// the pill truncates at the container's bounds.

import { statusMeta } from "./status-meta.js";

export { statusMeta } from "./status-meta.js";

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
