import { useCallback, useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.js";
import { useSSE } from "../lib/useSSE.js";
import { EmptyState } from "../components/EmptyState.jsx";
import { Icon } from "../components/Icon.jsx";
import { StatusSignal } from "../components/StatusSignal.jsx";
import { STATUS_TONES, modelDisplayName } from "../lib/display.js";

function fmtTime(ts) {
  return ts ? new Date(ts).toLocaleString() : "-";
}

function fmtCost(value) {
  return value == null ? "" : `$${Number(value).toFixed(4)}`;
}

export function Activity() {
  const [items, setItems] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async ({ append = false, cursor = null } = {}) => {
    setLoading(true);
    try {
      const res = await api.listActivity(cursor ? { cursor } : undefined);
      setItems((prev) => append ? [...prev, ...(res.items || [])] : (res.items || []));
      setNextCursor(res.nextCursor || null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useSSE("global", (evt) => {
    if (evt.type === "run_started" || evt.type === "run_ended" || evt.type === "agent_consolidated") load();
  });

  return (
    <div class="detail page-stack">
      <div class="page-header">
        <div>
          <div class="eyebrow">Run log</div>
          <h2 class="page-title">Activity</h2>
          <div class="page-copy">{items.length} recent items</div>
        </div>
        <button onClick={() => load()} disabled={loading}><Icon name="refresh-cw" size={15} />Refresh</button>
      </div>
      {items.length === 0 && !loading && (
        <EmptyState
          icon={<Icon name="clock" size={20} />}
          title="No runs yet"
          body={"Runs appear here as soon as you click \"Run now\" on a task or a scheduled consolidation fires."}
          cta={<a href="#/tasks" class="primary">Open the task board</a>}
        />
      )}
      {items.length === 0 && loading && <div class="surface-panel meta">Loading recent activity...</div>}
      <div class="activity-list">
        {items.map((item) => (
          <div class="activity-row" key={item.id}>
            <div>
              <strong>{item.mode === "consolidate" ? "Consolidation" : (item.task_title || item.mode)}</strong>
              <div class="meta">
                {item.mode} / {item.agent_name} / {fmtTime(item.started_at)}
                {item.ended_at && ` / ${fmtTime(item.ended_at)}`}
              </div>
              <div class="meta">
                {item.model && `${modelDisplayName(item.model)} / `}
                {item.input_tokens != null && `${item.input_tokens} in / ${item.output_tokens ?? 0} out / `}
                {item.duration_ms != null && `${item.duration_ms}ms / `}
                {fmtCost(item.cost_usd)}
              </div>
            </div>
            <div class="activity-row-side">
              <StatusSignal tone={STATUS_TONES[item.status] || "muted"} compact>{item.status}</StatusSignal>
              {item.task_id && <a href={`#/tasks/${item.task_id}?run=${item.id}`}>Open run</a>}
            </div>
          </div>
        ))}
      </div>
      {nextCursor && (
        <button disabled={loading} onClick={() => load({ append: true, cursor: nextCursor })}>
          {loading ? "Loading..." : "Load more"}
        </button>
      )}
    </div>
  );
}
