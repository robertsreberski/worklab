// §3.12 StatusDot — compact status indicator.
// Per §3.12: `pulse` is strictly tied to run.status === 'running'. Callers pass { pulse: true } only when a run
// is actively streaming events.
import { statusMeta } from "./status-meta.js";

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
