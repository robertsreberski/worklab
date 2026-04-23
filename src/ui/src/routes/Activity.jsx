import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../lib/api.js";
import { useSSE } from "../lib/useSSE.js";
import { AppShell } from "../components/AppShell.jsx";
import { AgentAvatar } from "../components/AgentAvatar.jsx";
import { Icon } from "../components/Icon.jsx";
import { StatusPill } from "../components/primitives/StatusPill.jsx";
import { modelDisplayName } from "../lib/display.js";

function fmtTime(ts) {
  return ts ? new Date(ts).toLocaleString() : "-";
}
function fmtAge(value) {
  if (!value) return "";
  const ms = Date.now() - Number(value);
  if (ms < 60_000) return "now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
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

  const tiles = useMemo(() => {
    const total = items.length;
    const running = items.filter((i) => i.status === "running").length;
    const errors = items.filter((i) => i.status === "error" || i.status === "failed").length;
    return { total, running, errors };
  }, [items]);

  const headerActions = (
    <button class="button" onClick={() => load()} disabled={loading}>
      <Icon name="refresh-cw" size={13} />
      {loading ? "Loading..." : "Refresh"}
    </button>
  );

  return (
    <AppShell route="activity" title="Activity" headerActions={headerActions}>
      <div class="page-wrap">
        <div class="summary-tiles">
          <div class="summary-tile">
            <span class="label">Items</span>
            <span class="value">{tiles.total}</span>
          </div>
          <div class={`summary-tile ${tiles.running > 0 ? "running" : ""}`}>
            <span class="label">Running</span>
            <span class="value">{tiles.running}</span>
          </div>
          <div class={`summary-tile ${tiles.errors > 0 ? "alert" : ""}`}>
            <span class="label">Errors</span>
            <span class="value">{tiles.errors}</span>
          </div>
        </div>

        {items.length === 0 && !loading && (
          <div class="empty-state">
            <Icon name="clock" size={28} />
            <h3>No activity yet</h3>
            <p>Runs appear here as soon as you click "Run now" on a task or a scheduled consolidation fires.</p>
            <a href="#/tasks" class="button primary">Open the task board</a>
          </div>
        )}

        <div class="surface-panel plain">
          <div class="activity-list">
            {items.map((item) => (
              <div class="activity-row" key={item.id}>
                <AgentAvatar name={item.agent_name} label={item.agent_name} size={24} />
                <div style={{ minWidth: 0 }}>
                  <div class="activity-title">
                    {item.mode === "consolidate" ? "Consolidation" : (item.task_title || item.mode)}
                  </div>
                  <div class="activity-meta">
                    {item.mode} · {item.agent_name}
                    {item.model && ` · ${modelDisplayName(item.model)}`}
                    {item.duration_ms != null && ` · ${item.duration_ms}ms`}
                    {item.input_tokens != null && ` · ${item.input_tokens} in / ${item.output_tokens ?? 0} out`}
                    {item.cost_usd != null && ` · ${fmtCost(item.cost_usd)}`}
                  </div>
                </div>
                <StatusPill status={item.status} size="sm" />
                <span class="activity-time" title={fmtTime(item.started_at)}>
                  {fmtAge(item.started_at)}
                  {item.task_id && (
                    <>
                      {" · "}
                      <a href={`#/tasks/${item.task_id}?run=${item.id}`}>open</a>
                    </>
                  )}
                </span>
              </div>
            ))}
          </div>
          {nextCursor && (
            <button
              class="button load-more-button"
              disabled={loading}
              onClick={() => load({ append: true, cursor: nextCursor })}
            >
              {loading ? "Loading..." : "Load more"}
            </button>
          )}
        </div>
      </div>
    </AppShell>
  );
}
