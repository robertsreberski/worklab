import { AgentEventTimeline } from "./AgentEventTimeline.jsx";

function eventHasVisibleText(ev) {
  const content = ev?.message?.content || ev?.content;
  return Array.isArray(content) && content.some((block) => block?.type === "text" && String(block.text || "").trim());
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
  const result = ev.worklab_result;
  if (result?.summary || result?.details) {
    const summary = String(result.summary || "").trim();
    const details = String(result.details || "").trim();
    if (summary && details && summary !== details) return `${summary}\n\n${details}`;
    return details || summary;
  }
  return ev.text || "Completed";
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
  if (ev.type === "worklab_result_candidate") return null;
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
  let sawAssistantText = false;
  return events.map((event) => {
    const normalized = normalizeWorklabEvent(event, {
      compactFinal: event?.type === "final" && sawAssistantText,
    });
    if (event?.type === "sdk_event" && eventHasVisibleText(event.event)) sawAssistantText = true;
    if (eventHasVisibleText(event)) sawAssistantText = true;
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
