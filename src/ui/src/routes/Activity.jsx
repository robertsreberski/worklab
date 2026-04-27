// §6.9 Activity — timeline of every run. Summary Metric tiles + flat list.
import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../lib/api.js";
import { useSSE } from "../lib/useSSE.js";
import { AppShell } from "../components/AppShell.jsx";
import { AgentAvatar } from "../components/AgentAvatar.jsx";
import { Icon } from "../components/Icon.jsx";
import { StatusPill } from "../components/primitives/StatusPill.jsx";
import { Button } from "../components/primitives/Button.jsx";
import { Select } from "../components/primitives/Select.jsx";
import { Input } from "../components/primitives/Input.jsx";
import { Metric } from "../components/Metric.jsx";
import { Card } from "../components/Card.jsx";
import { EmptyState } from "../components/EmptyState.jsx";
import { LoadingState } from "../components/LoadingState.jsx";
import { modelDisplayName, taskRouteId } from "../lib/display.js";
import { navigateHash } from "../lib/navigation.js";

function fmtTime(ts) { return ts ? new Date(ts).toLocaleString() : "-"; }
function fmtDuration(value) {
  if (value == null) return "";
  const ms = Number(value);
  if (!Number.isFinite(ms)) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}
function fmtAge(value) {
  if (!value) return "";
  const ms = Date.now() - Number(value);
  if (ms < 60_000) return "now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}
function fmtCost(value) { return value == null ? "" : `$${Number(value).toFixed(4)}`; }

function activityTitle(item) {
  if (item.mode === "consolidate") return "Consolidation";
  if (item.mode === "automation") return item.automation_title || "Automation";
  return item.task_title || item.mode;
}

export function Activity() {
  const [items, setItems] = useState(null);
  const [nextCursor, setNextCursor] = useState(null);
  const [loading, setLoading] = useState(false);
  const [agents, setAgents] = useState([]);
  const [agentFilter, setAgentFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const load = useCallback(async ({ append = false, cursor = null } = {}) => {
    setLoading(true);
    try {
      const query = {};
      if (cursor) query.cursor = cursor;
      if (agentFilter) query.agent = agentFilter;
      if (statusFilter) query.status = statusFilter;
      if (fromDate) query.from = fromDate;
      if (toDate) query.to = toDate;
      const res = await api.listActivity(query);
      setItems((prev) => append ? [...(prev || []), ...(res.items || [])] : (res.items || []));
      setNextCursor(res.nextCursor || null);
    } finally {
      setLoading(false);
    }
  }, [agentFilter, fromDate, statusFilter, toDate]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.listAgents().then((response) => setAgents(response.agents || [])).catch(() => setAgents([]));
  }, []);
  useSSE("global", (evt) => {
    if (evt.type === "run_started" || evt.type === "run_ended" || evt.type === "agent_consolidated") load();
  });

  const tiles = useMemo(() => {
    const list = items || [];
    const total = list.length;
    const running = list.filter((i) => i.status === "running").length;
    const errors = list.filter((i) => i.status === "error" || i.status === "failed").length;
    return { total, running, errors };
  }, [items]);

  const headerActions = (
    <Button variant="secondary" iconLeft={<Icon name="refresh-cw" size={13} />} onClick={() => load()} loading={loading}>
      Refresh
    </Button>
  );

  return (
    <AppShell route="activity" title="Activity" headerActions={headerActions}>
      <div class="page-wrap">
        <div class="summary-tiles">
          <Metric label="Items" value={tiles.total} />
          <Metric label="Running" value={tiles.running} />
          <Metric label="Errors" value={tiles.errors} />
        </div>

        <Card title="Filters">
          <div class="activity-filters">
            <Select
              variant="native"
              value={agentFilter}
              onChange={setAgentFilter}
              options={[
                { value: "", label: "All agents" },
                ...agents.map((agent) => ({ value: agent.name, label: agent.display_name || agent.name })),
              ]}
              ariaLabel="Filter by agent"
            />
            <Select
              variant="native"
              value={statusFilter}
              onChange={setStatusFilter}
              options={[
                { value: "", label: "All statuses" },
                { value: "running", label: "Running" },
                { value: "complete", label: "Complete" },
                { value: "error", label: "Error" },
                { value: "cancelled", label: "Cancelled" },
              ]}
              ariaLabel="Filter by status"
            />
            <Input type="date" value={fromDate} onInput={(e) => setFromDate(e.target.value)} ariaLabel="From date" />
            <Input type="date" value={toDate} onInput={(e) => setToDate(e.target.value)} ariaLabel="To date" />
          </div>
        </Card>

        {items === null && <LoadingState caption="Loading activity…" />}

        {items?.length === 0 && (
          <EmptyState
            icon={<Icon name="clock" size={48} />}
            title="No activity yet"
            body='Runs appear here as soon as you click "Run now" on a task, automation, or consolidation.'
            cta={<Button variant="primary" onClick={() => navigateHash("#/tasks")}>Open the task board</Button>}
          />
        )}

        {items?.length > 0 && (
          <Card>
	            <div class="activity-list">
	              {items.map((item) => (
	                <div class="activity-row" key={item.id}>
	                  <AgentAvatar name={item.agent_name} label={item.agent_name} size={24} />
	                  <div class="min-w-0">
	                    <div class="activity-title">
	                      {activityTitle(item)}
	                      {item.automation_trigger_type && item.mode !== "automation" && (
	                        <span class="chip chip-trigger">
	                          <Icon name="clock" size={10} /> Scheduled
	                        </span>
	                      )}
	                    </div>
	                    <div class="activity-meta">
	                      {item.mode} · {item.agent_name}
                      {item.automation_trigger_type && ` · ${item.automation_trigger_type}`}
                      {item.model && ` · ${modelDisplayName(item.model)}`}
                      {item.duration_ms != null && ` · ${fmtDuration(item.duration_ms)}`}
                      {item.input_tokens != null && ` · ${item.input_tokens} in / ${item.output_tokens ?? 0} out`}
                      {item.cost_usd != null && ` · ${fmtCost(item.cost_usd)}`}
                    </div>
                  </div>
                  <StatusPill status={item.status} size="sm" />
                  <span class="activity-time" title={fmtTime(item.started_at)}>
                    {fmtAge(item.started_at)}
                    {item.task_id && (
                      <>{" · "}<a href={`#/tasks/${taskRouteId({ id: item.task_id, task_key: item.task_key })}?run=${item.id}`}>open</a></>
                    )}
                  </span>
                </div>
              ))}
            </div>
            {nextCursor && (
              <div class="form-actions">
                <Button variant="secondary" onClick={() => load({ append: true, cursor: nextCursor })} loading={loading}>
                  Load more
                </Button>
              </div>
            )}
          </Card>
        )}
      </div>
    </AppShell>
  );
}
