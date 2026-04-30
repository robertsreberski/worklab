import { AgentEventTimeline } from "./AgentEventTimeline.jsx";
import { normalizeCommentText } from "../lib/commentFormatting.js";
import { normalizeCodexItemEvent } from "../../../ai/streaming/codex-events.js";

function visibleTextFromEvent(ev) {
  if (ev?.type === "sdk_event") return visibleTextFromEvent(ev.event);
  if (ev?.type !== "assistant" && ev?.type !== "message") return "";
  const content = ev?.message?.content || ev?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && String(block.text || "").trim())
    .map((block) => block.text)
    .join("");
}

function isVisibleTextEvent(ev) {
  if (ev?.type === "sdk_event") return isVisibleTextEvent(ev.event);
  if (ev?.type !== "assistant" && ev?.type !== "message") return false;
  const content = ev?.message?.content || ev?.content;
  return Array.isArray(content)
    && content.length > 0
    && content.every((block) => block?.type === "text" && String(block.text || "").trim());
}

function mergeVisibleText(current, next) {
  const left = current || "";
  const right = next || "";
  if (!right) return left;
  if (!left) return right;
  if (left === right) return left;

  const leftTrimmed = left.trim();
  const rightTrimmed = right.trim();
  if (leftTrimmed && rightTrimmed) {
    if (leftTrimmed === rightTrimmed) return left;
    if (rightTrimmed.length >= leftTrimmed.length && rightTrimmed.startsWith(leftTrimmed)) return right;
  }

  return `${left}${right}`;
}

function formatFinalUsage(ev) {
  const usage = ev.usage || {};
  return [
    ev.model,
    usage.input_tokens != null ? `in ${usage.input_tokens}` : null,
    usage.output_tokens != null ? `out ${usage.output_tokens}` : null,
    usage.cache_read_tokens != null ? `cache ${usage.cache_read_tokens}` : null,
    ev.durationMs != null ? `${ev.durationMs}ms` : null,
    ev.numTurns != null ? `${ev.numTurns} turns` : null,
    usage.cost_usd != null ? `$${Number(usage.cost_usd).toFixed(5)}` : null,
  ].filter(Boolean).join(" / ");
}

function formatFinalText(ev) {
  const rawText = String(ev.text || "").trim();
  const delivered = normalizeCommentText(rawText);
  if (delivered && (delivered !== rawText || !/^[{[]/.test(rawText))) return delivered;
  const result = ev.worklab_result;
  if (result?.final_text || result?.summary || result?.details) {
    const finalText = String(result.final_text || "").trim();
    if (finalText) return finalText;
    const summary = String(result.summary || "").trim();
    const details = String(result.details || "").trim();
    if (summary && details && summary !== details) return `${summary}\n\n${details}`;
    return details || summary;
  }
  return ev.text || "Completed";
}

function providerResultErrorMessage(ev) {
  const subtype = typeof ev?.subtype === "string" ? ev.subtype : "";
  const hasErrors = Array.isArray(ev?.errors) && ev.errors.length > 0;
  if (!ev?.is_error && !subtype.startsWith("error_") && !hasErrors && !ev?.error) return "";
  if (subtype === "error_max_turns") return "Stopped before final output: max turns reached";
  const label = subtype ? subtype.replace(/^error_/, "").replace(/_/g, " ") : "provider error";
  const detail = typeof ev?.error === "string" ? ev.error : ev?.error?.message;
  return detail ? `${label}: ${detail}` : label;
}

const HIDDEN_CLI_EVENT_TYPES = new Set([
  "hook_started",
  "hook_response",
  "init",
  "rate_limit_event",
]);

function normalizeCliEvent(ev) {
  const raw = ev?.raw;
  if (!raw) return ev;
  const codexItem = normalizeCodexItemEvent(raw);
  if (codexItem) return codexItem;
  if (HIDDEN_CLI_EVENT_TYPES.has(raw.type) || HIDDEN_CLI_EVENT_TYPES.has(raw.subtype)) return null;
  if (raw.type === "error") {
    return { type: "error", message: raw.message || raw.error || "CLI error" };
  }
  if (raw.type === "result") {
    const usage = raw.usage || {};
    const parts = [
      usage.input_tokens != null ? `in ${usage.input_tokens}` : null,
      usage.output_tokens != null ? `out ${usage.output_tokens}` : null,
      raw.duration_ms != null ? `${raw.duration_ms}ms` : null,
      raw.num_turns != null ? `${raw.num_turns} turns` : null,
    ].filter(Boolean);
    return { type: "result", text: parts.length ? parts.join(" / ") : "Completed" };
  }
  return ev;
}

function normalizeWorklabEvent(ev, { compactFinal = false } = {}) {
  if (!ev) return null;
  if (ev.type === "sdk_event") return normalizeWorklabEvent(ev.event, { compactFinal });
  if (ev.type === "live_user_message") {
    return {
      type: "live_user_message",
      text: ev.body || ev.text || "",
      created_at: ev.created_at || null,
    };
  }
  if (ev.type === "worklab_result_candidate") return null;
  if (ev.type === "worklab_result_error") return { type: "error", message: ev.message || "Invalid worklab_result" };
  if (ev.type === "structured_output") {
    return {
      type: "structured_output",
      tool_use_id: ev.tool_use_id || null,
      source: ev.source || "StructuredOutput",
      value: ev.value ?? ev.structured_output ?? ev.result,
      ...(ev.worklab_result ? { worklab_result: ev.worklab_result } : {}),
    };
  }
  const codexItem = normalizeCodexItemEvent(ev);
  if (codexItem) return codexItem;
  if (ev.type === "cli_event") return normalizeCliEvent(ev);
  if (ev.type === "final") {
    const usage = formatFinalUsage(ev);
    if (compactFinal) {
      return {
        type: "final",
        compact: true,
        text: ev.text || "",
        summary: usage,
        usage: ev.usage || {},
        model: ev.model,
        durationMs: ev.durationMs,
        numTurns: ev.numTurns,
      };
    }
    const text = formatFinalText(ev);
    return {
      type: "final",
      text: usage ? `${text}\n\n${usage}` : text,
      ...(ev.worklab_result ? { structured: ev.worklab_result } : {}),
    };
  }
  if (ev.type === "result") {
    const resultError = providerResultErrorMessage(ev);
    if (resultError) return { type: "error", message: resultError };
    const usage = ev.usage || {};
    const parts = [
      usage.input_tokens != null ? `in ${usage.input_tokens}` : null,
      usage.output_tokens != null ? `out ${usage.output_tokens}` : null,
      ev.duration_ms != null ? `${ev.duration_ms}ms` : null,
      ev.num_turns != null ? `${ev.num_turns} turns` : null,
    ].filter(Boolean);
    return {
      ...ev,
      text: parts.length ? parts.join(" / ") : "Completed",
      ...(
        ev.worklab_result || (ev.result && typeof ev.result === "object")
          ? { structured: ev.worklab_result || ev.result }
          : {}
      ),
    };
  }
  return ev;
}

export function normalizeWorklabEvents(events = []) {
  const visibleTexts = new Set();
  let visibleTextTail = "";
  return events.map((event) => {
    const rawFinalText = String(event?.text || "").trim();
    const normalizedFinalText = normalizeCommentText(rawFinalText);
    const compactFinal = event?.type === "final" && (
      normalizedFinalText
        ? visibleTexts.has(normalizedFinalText)
        : visibleTexts.size > 0
    );
    const normalized = normalizeWorklabEvent(event, {
      compactFinal,
    });
    const visibleText = normalizeCommentText(visibleTextFromEvent(event));
    if (visibleText) {
      visibleTextTail = isVisibleTextEvent(event)
        ? mergeVisibleText(visibleTextTail, visibleText)
        : visibleText;
      visibleTexts.add(visibleText);
      visibleTexts.add(visibleTextTail);
    } else if (!isVisibleTextEvent(event)) {
      visibleTextTail = "";
    }
    return normalized;
  }).filter(Boolean);
}

export function EventTimeline({ events, streaming = false }) {
  if (!events.length) return <div class="meta">{streaming ? "Waiting for first agent event..." : "No events yet."}</div>;
  return (
    <AgentEventTimeline
      events={normalizeWorklabEvents(events)}
      streaming={streaming}
    />
  );
}
