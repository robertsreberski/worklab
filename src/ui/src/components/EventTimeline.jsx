// src/ui/src/components/EventTimeline.jsx
function renderSdkEvent(ev) {
  if (ev.type === "assistant" && ev.message?.content) {
    return ev.message.content.map((block, i) => {
      if (block.type === "text") return <div key={i} class="comment" style="border-left:3px solid var(--accent)"><div class="author">assistant</div>{block.text}</div>;
      if (block.type === "tool_use") return <div key={i} class="comment" style="border-left:3px solid #d9a656"><div class="author">tool_use · {block.name}</div><pre style="white-space:pre-wrap;margin:0;font-size:11px">{JSON.stringify(block.input, null, 2)}</pre></div>;
      if (block.type === "thinking") return <div key={i} class="comment" style="border-left:3px solid #6a6a8c;opacity:0.8"><div class="author">thinking</div>{block.thinking || block.text || ""}</div>;
      return null;
    });
  }
  if (ev.type === "user" && ev.message?.content) {
    return ev.message.content.map((block, i) => {
      if (block.type === "tool_result") return <div key={i} class="comment" style="border-left:3px solid #6ac26a;opacity:0.9"><div class="author">tool_result</div><pre style="white-space:pre-wrap;margin:0;font-size:11px">{typeof block.content === "string" ? block.content : JSON.stringify(block.content, null, 2)}</pre></div>;
      return null;
    });
  }
  if (ev.type === "result") {
    const u = ev.usage || {};
    return <div class="comment" style="border-left:3px solid var(--muted)"><div class="author">result</div>in {u.input_tokens ?? "?"} / out {u.output_tokens ?? "?"} tokens · {ev.duration_ms ?? "?"}ms · {ev.num_turns ?? "?"} turns</div>;
  }
  return null;
}

function renderMessage(ev) {
  if (ev.type === "started") return <div class="meta">▶ run started</div>;
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
    ].filter(Boolean).join(" · ");
    return <div class="comment" style="border-left:3px solid var(--accent);background:var(--panel)"><div class="author">final{usage ? ` · ${usage}` : ""}</div>{ev.text}</div>;
  }
  if (ev.type === "error") return <div class="comment" style="border-left:3px solid #ff7a7a"><div class="author">error</div>{ev.message}</div>;
  if (ev.type === "cancelled") return <div class="meta">✕ cancelled</div>;
  if (ev.type === "sdk_event") return renderSdkEvent(ev.event);
  return null;
}

export function EventTimeline({ events }) {
  if (!events.length) return <div class="meta">No events yet.</div>;
  return <div>{events.map((e, i) => <div key={i}>{renderMessage(e)}</div>)}</div>;
}
