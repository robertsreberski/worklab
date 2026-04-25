// §3.16 ToolToken — compact representation of one tool call / thought / handoff /
// text event. Mono label truncated at 320px (256 compact). Trailing status glyph.
import { Icon } from "../Icon.jsx";

const STATUS_GLYPH = {
  running: "◐",
  done: "✓",
  error: "✕",
};

function previewValue(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function normalizeToolTokenEvent(event) {
  if (!event) return null;
  if (event.type === "sdk_event") return normalizeToolTokenEvent(event.event);

  const content = event.message?.content || event.content;
  if ((event.type === "assistant" || event.type === "message" || event.type === "user") && Array.isArray(content)) {
    for (let index = content.length - 1; index >= 0; index -= 1) {
      const next = normalizeToolTokenEvent(content[index]);
      if (next) return next;
    }
  }

  if (event.type === "tool_use") {
    return {
      ...event,
      name: event.name || event.tool || "tool",
      arg: previewValue(event.input ?? event.arguments ?? event.arg),
    };
  }
  if (event.type === "tool_result") {
    const output = previewValue(event.output ?? event.content ?? event.result);
    return {
      type: "text",
      text: output ? `Tool result: ${output}` : "Tool result",
    };
  }
  if (event.type === "thinking") {
    return { ...event, text: event.text || event.thinking || "" };
  }
  if (event.type === "runtime_warning") {
    return {
      type: "text",
      text: `Warning: ${event.message || event.warning_kind || "runtime warning"}`,
    };
  }
  if (event.type === "started") return { type: "text", text: "Run started" };
  if (event.type === "error") return { type: "text", text: `Error: ${event.message || "run failed"}` };
  if (event.type === "final") {
    return {
      type: "text",
      text: event.worklab_result?.summary || event.text || "Completed",
    };
  }
  if (event.type === "verdict") {
    return {
      type: "text",
      text: event.verdict ? `Verdict: ${event.verdict}` : "Review verdict",
    };
  }
  if (event.type === "cli_event" && event.raw) return normalizeToolTokenEvent(event.raw);
  return event;
}

export function ToolToken({ event, compact = false }) {
  event = normalizeToolTokenEvent(event);
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
