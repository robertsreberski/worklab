// §3.16 ToolToken — compact representation of one tool call / thought / handoff /
// text event. Mono label truncated at 320px (256 compact). Trailing status glyph.
import { Icon } from "../Icon.jsx";
import { normalizeCodexItemType } from "@mono-agent/agent-runtime/ai/streaming/codex-events.js";
import { fileEditChangeLabel } from "../../lib/fileEditDisplay.js";
import { fileEditDisplayName } from "../../lib/toolEventLinking.js";

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

function fileChangeLabel(changes = []) {
  const list = Array.isArray(changes) ? changes : [];
  return list
    .map((change) => fileEditChangeLabel(change))
    .filter(Boolean)
    .join(", ");
}

function normalizeFileChangeToken(event) {
  if ((event?.type !== "item.started" && event?.type !== "item.completed") || normalizeCodexItemType(event.item?.type) !== "file_change") return null;
  return {
    type: "tool_use",
    name: "file_edit",
    arg: fileChangeLabel(event.item.changes),
    status: event.type === "item.completed" ? (event.item.error ? "error" : "done") : "running",
  };
}

function itemStatus(event) {
  const status = String(event?.item?.status || "").toLowerCase();
  const exitCode = event?.item?.exit_code ?? event?.item?.exitCode;
  if (event?.type !== "item.completed") return "running";
  if (
    event.item?.error ||
    status === "failed" ||
    status === "errored" ||
    status === "error" ||
    (typeof exitCode === "number" && exitCode !== 0)
  ) return "error";
  return "done";
}

function normalizeCodexItemToken(event) {
  if (event?.type !== "item.started" && event?.type !== "item.completed") return null;
  const item = event.item || {};
  const type = normalizeCodexItemType(item.type);
  if (type === "command_execution") {
    return {
      type: "tool_use",
      name: "command_execution",
      arg: previewValue(item.command || ""),
      status: itemStatus(event),
    };
  }
  if (type === "mcp_tool_call") {
    return {
      type: "tool_use",
      name: item.server && item.tool ? `mcp__${item.server}__${item.tool}` : item.tool || "mcp_tool_call",
      arg: previewValue(item.arguments || {}),
      status: itemStatus(event),
    };
  }
  return null;
}

export function normalizeToolTokenEvent(event) {
  if (!event) return null;
  if (event.type === "sdk_event") return normalizeToolTokenEvent(event.event);
  if (event.type === "worklab_result_candidate") return null;
  if (event.type === "structured_output") {
    const value = event.worklab_result || event.value || event.structured_output || {};
    return {
      type: "text",
      text: value.final_text || value.summary || "Structured output",
    };
  }
  const fileChange = normalizeFileChangeToken(event);
  if (fileChange) return fileChange;
  const codexItem = normalizeCodexItemToken(event);
  if (codexItem) return codexItem;

  const content = event.message?.content || event.content;
  if ((event.type === "assistant" || event.type === "message" || event.type === "user") && Array.isArray(content)) {
    if (event._worklab_acp_projected === true) {
      const toolUse = content.find((block) => block?.type === "tool_use");
      if (toolUse) {
        const toolUseId = toolUse.tool_use_id || toolUse.id;
        const toolResult = content.find((block) => (
          block?.type === "tool_result"
          && (block.tool_use_id || block.id) === toolUseId
        ));
        const token = normalizeToolTokenEvent(toolUse);
        return token ? {
          ...token,
          status: toolResult
            ? (toolResult.is_error || toolResult.error ? "error" : "done")
            : "running",
        } : null;
      }
    }
    for (let index = content.length - 1; index >= 0; index -= 1) {
      const next = normalizeToolTokenEvent(content[index]);
      if (next) return next;
    }
  }

  if (event.type === "tool_use") {
    const name = event.name || event.tool || "tool";
    if (name === "file_edit") {
      return {
        ...event,
        name,
        arg: fileChangeLabel(event.input?.changes),
        status: event.input?.status === "completed" ? "done" : event.input?.status === "failed" ? "error" : event.input?.status === "in_progress" ? "running" : event.status,
      };
    }
    return {
      ...event,
      name,
      arg: previewValue(event.input ?? event.arguments ?? event.arg),
    };
  }
  if (event.type === "tool_result") {
    const payload = event.output ?? event.content ?? event.result;
    if (payload?.changes && payload?.status) {
      return {
        type: "tool_use",
        name: "file_edit",
        arg: fileChangeLabel(payload.changes),
        status: event.is_error || event.error ? "error" : "done",
      };
    }
    const output = previewValue(payload);
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
      text: event.worklab_result?.final_text || event.worklab_result?.summary || event.text || "Completed",
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
  const displayName = event.name === "file_edit" ? fileEditDisplayName(event) || name : name;
  const arg = event.arg || event.input_preview || event.argument || "";
  const detail = event.detail || "";
  const fullLabel = `${displayName}${arg ? `(${arg})` : ""}${detail ? ` · ${detail}` : ""}`;
  return (
    <span class={cls} title={fullLabel}>
      <span class="tool-token-name">{displayName}</span>
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
