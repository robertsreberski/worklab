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

function normalizeWorklabEvent(ev, { compactFinal = false } = {}) {
  if (!ev) return null;
  if (ev.type === "sdk_event") return ev.event;
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
    return {
      type: "final",
      text: usage ? `${ev.text || "Completed"}\n\n${usage}` : (ev.text || "Completed"),
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
    return { ...ev, text: parts.length ? parts.join(" / ") : "Completed" };
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
  if (!events.length) return <div class="meta">No events yet.</div>;
  return (
    <AgentEventTimeline
      events={normalizeWorklabEvents(events)}
      streaming={streaming}
    />
  );
}
