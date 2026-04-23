import { AgentEventTimeline } from "./AgentEventTimeline.jsx";

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

function normalizeWorklabEvent(ev) {
  if (!ev) return null;
  if (ev.type === "sdk_event") return ev.event;
  if (ev.type === "final") {
    const usage = formatFinalUsage(ev);
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

export function EventTimeline({ events, streaming = false }) {
  if (!events.length) return <div class="meta">No events yet.</div>;
  return (
    <AgentEventTimeline
      events={events.map(normalizeWorklabEvent).filter(Boolean)}
      streaming={streaming}
    />
  );
}
