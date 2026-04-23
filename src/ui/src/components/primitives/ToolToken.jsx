import { Icon } from "../Icon.jsx";

export function ToolToken({ event, compact = false }) {
  if (!event) return null;
  const cls = `tool-token${compact ? " compact" : ""}`;
  if (event.kind === "think" || event.type === "thinking") {
    const text = event.text || event.content || "Thinking...";
    return (
      <span class={`${cls} tool-token-think`}>
        <span class="tool-token-glyph" aria-hidden="true">✦</span>
        <span class="tool-token-text">{text}</span>
      </span>
    );
  }
  if (event.kind === "handoff") {
    return (
      <span class={`${cls} tool-token-handoff`}>
        <Icon name="arrow-right" size={compact ? 10 : 11} />
        <span>{event.text || event.name}</span>
      </span>
    );
  }
  if (event.kind === "text" || event.type === "text") {
    const text = event.text || event.content || "";
    return (
      <span class={`${cls} tool-token-text-event`}>
        <span class="tool-token-glyph" aria-hidden="true">›</span>
        <span class="tool-token-text">{text}</span>
      </span>
    );
  }
  const name = event.name || event.tool || "tool";
  const arg = event.arg || event.input_preview || event.argument || "";
  const detail = event.detail || "";
  return (
    <span class={cls}>
      <span class="tool-token-name">{name}</span>
      {(arg || detail) && (
        <span class="tool-token-arg">
          {arg}
          {detail ? ` · ${detail}` : ""}
        </span>
      )}
    </span>
  );
}
