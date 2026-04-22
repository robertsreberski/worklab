// src/ui/src/components/EventTimeline.jsx
function renderSdkEvent(ev) {
  if (ev.type === "assistant" && ev.message?.content) {
    return ev.message.content.map((block, i) => {
      if (block.type === "text") return <div key={i} class="comment event-block assistant"><div class="author">assistant</div>{block.text}</div>;
      if (block.type === "tool_use") return <div key={i} class="comment event-block tool-use"><div class="author">tool_use / {block.name}</div><pre>{JSON.stringify(block.input, null, 2)}</pre></div>;
      if (block.type === "thinking") return <div key={i} class="comment event-block thinking"><div class="author">thinking</div>{block.thinking || block.text || ""}</div>;
      return null;
    });
  }
  if (ev.type === "user" && ev.message?.content) {
    return ev.message.content.map((block, i) => {
      if (block.type === "tool_result") return <div key={i} class="comment event-block tool-result"><div class="author">tool_result</div><pre>{typeof block.content === "string" ? block.content : JSON.stringify(block.content, null, 2)}</pre></div>;
      return null;
    });
  }
  if (ev.type === "result") {
    const u = ev.usage || {};
    return <div class="comment event-block"><div class="author">result</div>in {u.input_tokens ?? "?"} / out {u.output_tokens ?? "?"} tokens / {ev.duration_ms ?? "?"}ms / {ev.num_turns ?? "?"} turns</div>;
  }
  return null;
}

function renderMessage(ev) {
  if (ev.type === "started") return <div class="meta">Run started</div>;
  if (ev.type === "final") {
    const u = ev.usage || {};
    const usage = [
      ev.model,
      u.input_tokens != null ? `in ${u.input_tokens}` : null,
      u.output_tokens != null ? `out ${u.output_tokens}` : null,
      u.cache_read_tokens != null ? `cache ${u.cache_read_tokens}` : null,
      ev.durationMs != null ? `${ev.durationMs}ms` : null,
      ev.numTurns != null ? `${ev.numTurns} turns` : null,
      u.cost_usd != null ? `$${Number(u.cost_usd).toFixed(5)}` : null,
    ].filter(Boolean).join(" / ");
    return <div class="comment event-block final"><div class="author">final{usage ? ` / ${usage}` : ""}</div>{ev.text}</div>;
  }
  if (ev.type === "error") return <div class="comment event-block error"><div class="author">error</div>{ev.message}</div>;
  if (ev.type === "cancelled") return <div class="meta">Cancelled</div>;
  if (ev.type === "sdk_event") return renderSdkEvent(ev.event);
  return null;
}

export function EventTimeline({ events }) {
  if (!events.length) return <div class="meta">No events yet.</div>;
  return <div class="event-timeline">{events.map((e, i) => <div key={i}>{renderMessage(e)}</div>)}</div>;
}
