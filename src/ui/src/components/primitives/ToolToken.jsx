// §3.16 ToolToken — compact representation of one tool call / thought / handoff /
// text event. Mono label truncated at 320px (256 compact). Trailing status glyph.
import { Icon } from "../Icon.jsx";

const STATUS_GLYPH = {
  running: "◐",
  done: "✓",
  error: "✕",
};

export function ToolToken({ event, compact = false }) {
  if (!event) return null;
  const cls = `tool-token${compact ? " compact" : ""}`;
  const status = event.status;
  const statusMark = status && STATUS_GLYPH[status]
    ? <span class={`tool-token-status-${status}`} aria-hidden="true">{STATUS_GLYPH[status]}</span>
    : null;

  if (event.kind === "think" || event.type === "thinking") {
    const text = event.text || event.content || "Thinking...";
    return (
      <span class={`${cls} tool-token-think`} title={text}>
        <span class="tool-token-glyph" aria-hidden="true">✦</span>
        <span class="tool-token-text">{text}</span>
      </span>
    );
  }
  if (event.kind === "handoff") {
    return (
      <span class={`${cls} tool-token-handoff`} title={event.text || event.name}>
        <Icon name="arrow-right" size={compact ? 10 : 11} />
        <span>{event.text || event.name}</span>
      </span>
    );
  }
  if (event.kind === "text" || event.type === "text") {
    const text = event.text || event.content || "";
    return (
      <span class={`${cls} tool-token-text-event`} title={text}>
        <span class="tool-token-glyph" aria-hidden="true">›</span>
        <span class="tool-token-text">{text}</span>
      </span>
    );
  }
  const name = event.name || event.tool || "tool";
  const arg = event.arg || event.input_preview || event.argument || "";
  const detail = event.detail || "";
  const fullLabel = `${name}${arg ? `(${arg})` : ""}${detail ? ` · ${detail}` : ""}`;
  return (
    <span class={cls} title={fullLabel}>
      <span class="tool-token-name">{name}</span>
      {(arg || detail) && (
        <span class="tool-token-arg">
          {arg}
          {detail ? ` · ${detail}` : ""}
        </span>
      )}
      {statusMark}
    </span>
  );
}
