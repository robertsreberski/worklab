// §4.15 EventRow — atom of the event timeline.
// Unified typography:
//   text/thinking: sans --text-base line-height 1.5
//   tool output/code: mono --text-sm on --surface-sunken
//   meta: mono --text-xs --text-muted
//   phase header: sans --text-sm --text-muted
import { Icon } from "./Icon.jsx";

const GLYPH = {
  tool: "wrench",
  text: "message-square",
  thinking: "sparkles",
  phase: "circle",
  final: "check",
  error: "alert-triangle",
};

function formatRelativeMs(ms) {
  if (ms == null) return null;
  if (ms < 1000) return `+${ms}ms`;
  if (ms < 60_000) return `+${Math.round(ms / 100) / 10}s`;
  return `+${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

export function EventRow({
  kind = "text",
  label,
  relativeMs,
  durationMs,
  isNew = false,
  isStreaming = false,
  showLine = true,
  children,
  class: className = "",
}) {
  const rel = formatRelativeMs(relativeMs);
  const dur = formatRelativeMs(durationMs);
  return (
    <div class={`event-row ${isNew ? "new" : ""} ${className}`.trim()}>
      <div class="event-row-rail">
        <span class={`event-row-glyph ${kind}`} aria-hidden="true">
          <Icon name={GLYPH[kind] || "circle"} size={8} />
        </span>
        {showLine && <span class="event-row-line" aria-hidden="true" />}
      </div>
      <div class="event-row-content">
        {(label || rel || dur) && (
          <div class="event-row-header">
            {label && <span>{label}</span>}
            {rel && <span class="event-row-timestamp">{rel}</span>}
            {dur && <span class="event-row-duration">· {dur}</span>}
          </div>
        )}
        {children}
        {isStreaming && <span class="event-row-caret" aria-hidden="true" />}
      </div>
    </div>
  );
}
