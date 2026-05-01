// §6.9 Activity — premium run activity dashboard.
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api } from "../lib/api.js";
import { useSSE } from "../lib/useSSE.js";
import { useThrottledCallback } from "../lib/useThrottledCallback.js";
import { AppShell } from "../components/AppShell.jsx";
import { AgentAvatar } from "../components/AgentAvatar.jsx";
import { Icon } from "../components/Icon.jsx";
import { StatusPill } from "../components/primitives/StatusPill.jsx";
import { Button } from "../components/primitives/Button.jsx";
import { Select } from "../components/primitives/Select.jsx";
import { DateRangePicker } from "../components/primitives/DatePicker.jsx";
import { Card } from "../components/Card.jsx";
import { EmptyState } from "../components/EmptyState.jsx";
import { LoadingState } from "../components/LoadingState.jsx";
import { Page } from "../components/layout/index.js";
import { modelDisplayName, taskRouteId } from "../lib/display.js";
import { navigateHash } from "../lib/navigation.js";

const COUNT_FORMATTER = new Intl.NumberFormat();
const DAY_FORMATTER = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "running", label: "Running" },
  { value: "complete", label: "Complete" },
  { value: "error", label: "Error" },
  { value: "cancelled", label: "Cancelled" },
];

function fmtTime(ts) { return ts ? new Date(ts).toLocaleString() : "-"; }
function fmtDay(value) {
  if (!value) return "-";
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) ? DAY_FORMATTER.format(new Date(parsed)) : value;
}
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
function fmtCount(value) { return COUNT_FORMATTER.format(Number(value || 0)); }
function pct(count, total) {
  if (!total) return 0;
  return Math.max(0, Math.min(100, Math.round((Number(count || 0) / Number(total)) * 100)));
}

function activityTitle(item) {
  if (item.mode === "consolidate") return "Consolidation";
  if (item.mode === "automation") return item.automation_title || "Automation";
  return item.task_title || item.mode;
}

function agentLeadingSlot(option) {
  if (!option?.value) return <Icon name="users" size={14} />;
  return <AgentAvatar name={option.value} label={option.label || option.value} size={18} />;
}

function statusLeadingSlot(option) {
  if (!option?.value) return <Icon name="filter" size={14} />;
  return <span class="activity-status-swatch" data-status={option.value} aria-hidden="true" />;
}

function activityMetaParts(item) {
  return [
    item.mode,
    item.agent_name,
    item.automation_trigger_type,
    item.model ? modelDisplayName(item.model) : null,
  ].filter(Boolean);
}

function activityMetricParts(item) {
  const parts = [];
  if (item.duration_ms != null) parts.push({ key: "duration", icon: "clock", label: fmtDuration(item.duration_ms) });
  if (item.input_tokens != null) {
    parts.push({
      key: "tokens",
      icon: "terminal",
      label: `${fmtCount(item.input_tokens)} in / ${fmtCount(item.output_tokens ?? 0)} out`,
    });
  }
  if (item.cost_usd != null) parts.push({ key: "cost", icon: "database", label: fmtCost(item.cost_usd) });
  return parts;
}

function costChartDays(rows) {
  const days = Array.isArray(rows) ? rows : [];
  const maxCost = Math.max(0, ...days.map((day) => Number(day.total_cost_usd || 0)));
  return days.map((day) => {
    const total = Number(day.total_cost_usd || 0);
    const count = Number(day.costed_run_count || 0);
    const pctOfMax = maxCost > 0 ? Math.round((total / maxCost) * 100) : 0;
    return {
      date: day.date,
      label: fmtDay(day.date),
      total,
      count,
      costLabel: fmtCost(total),
      height: total > 0 ? Math.max(8, pctOfMax) : 0,
    };
  });
}

export function Activity() {
  const [items, setItems] = useState(null);
  const [summary, setSummary] = useState(null);
  const [nextCursor, setNextCursor] = useState(null);
  const [loading, setLoading] = useState(false);
  const [agents, setAgents] = useState([]);
  const [agentFilter, setAgentFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [dateRange, setDateRange] = useState({ from: "", to: "" });
  const loadAbortRef = useRef(null);

  const load = useCallback(async ({ append = false, cursor = null } = {}) => {
    loadAbortRef.current?.abort?.();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    setLoading(true);
    try {
      const query = {};
      if (cursor) query.cursor = cursor;
      if (agentFilter) query.agent = agentFilter;
      if (statusFilter) query.status = statusFilter;
      if (dateRange.from) query.from = dateRange.from;
      if (dateRange.to) query.to = dateRange.to;
      const res = await api.listActivity(query, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setItems((prev) => append ? [...(prev || []), ...(res.items || [])] : (res.items || []));
      setSummary(res.summary || null);
      setNextCursor(res.nextCursor || null);
    } catch (err) {
      if (err?.name !== "AbortError") {
        setItems([]);
        setSummary(null);
        setNextCursor(null);
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [agentFilter, dateRange.from, dateRange.to, statusFilter]);
  const loadSoon = useThrottledCallback(() => load(), 100);

  useEffect(() => { load(); }, [load]);
  useEffect(() => () => loadAbortRef.current?.abort?.(), []);
  useEffect(() => {
    const controller = new AbortController();
    api.listAgents({ signal: controller.signal }).then((response) => setAgents(response.agents || [])).catch((err) => {
      if (err?.name !== "AbortError") setAgents([]);
    });
    return () => controller.abort();
  }, []);
  useSSE("global", (evt) => {
    if (evt.type === "run_started" || evt.type === "run_ended" || evt.type === "agent_consolidated") loadSoon();
  });

  const stats = useMemo(() => {
    const runs = Number(summary?.run_count || 0);
    const costedRuns = Number(summary?.costed_run_count || 0);
    const running = Number(summary?.running_count || 0);
    const errors = Number(summary?.error_count || 0);
    const settled = Math.max(0, runs - running - errors);
    return {
      runs,
      costedRuns,
      running,
      errors,
      settled,
      totalCost: fmtCost(summary?.total_cost_usd ?? 0),
      averageCost: summary?.average_cost_usd != null ? fmtCost(summary.average_cost_usd) : "-",
      costDays: costChartDays(summary?.cost_by_day),
      runningPct: pct(running, runs),
      errorPct: pct(errors, runs),
      settledPct: pct(settled, runs),
    };
  }, [summary]);

  const pageActions = (
    <Button variant="secondary" iconLeft={<Icon name="refresh-cw" size={13} />} onClick={() => load()} loading={loading}>
      Refresh
    </Button>
  );
  const activeFilterCount = [agentFilter, statusFilter, dateRange.from, dateRange.to].filter(Boolean).length;

  return (
    <AppShell route="activity">
      <Page
        kicker="Activity"
        title="Activity"
        description="Recent task runs, automations, and consolidation events."
        actions={pageActions}
      >
        <section class="activity-stats" aria-label="Activity statistics">
          <article class="activity-stat-card activity-stat-card-primary activity-stat-cost">
            <div class="activity-stat-head">
              <span class="activity-stat-label">Cost history</span>
              <span class="activity-stat-icon"><Icon name="calendar" size={15} /></span>
            </div>
            <strong class="activity-stat-value">{stats.totalCost}</strong>
            <div class="activity-stat-subline">
              <span>{stats.averageCost}/run avg</span>
              <span>{fmtCount(stats.costedRuns)} costed</span>
            </div>
            <div
              class="activity-cost-chart"
              aria-label={`${dateRange.from || dateRange.to ? "Selected range" : "Recent days"} cost by day`}
            >
              {stats.costDays.length > 0 ? stats.costDays.map((day) => (
                <span class="activity-cost-day" title={`${day.label}: ${day.costLabel} across ${fmtCount(day.count)} run${day.count === 1 ? "" : "s"}`} key={day.date}>
                  <span class="activity-cost-bar" aria-hidden="true">
                    <span style={{ height: `${day.height}%` }} />
                  </span>
                  <span class="activity-cost-day-label">{day.label}</span>
                </span>
              )) : (
                <span class="activity-cost-empty">No cost data</span>
              )}
            </div>
          </article>

          <article class="activity-stat-card activity-stat-card-primary activity-stat-health">
            <div class="activity-stat-head">
              <span class="activity-stat-label">Run Health</span>
              <span class="activity-stat-icon"><Icon name="check-circle" size={15} /></span>
            </div>
            <strong class="activity-stat-value">{fmtCount(stats.runs)}</strong>
            <div
              class="activity-health-bar"
              aria-label={`${stats.settledPct}% settled, ${stats.runningPct}% running, ${stats.errorPct}% error`}
            >
              <span class="activity-health-segment settled" style={{ width: `${stats.settledPct}%` }} />
              <span class="activity-health-segment running" style={{ width: `${stats.runningPct}%` }} />
              <span class="activity-health-segment error" style={{ width: `${stats.errorPct}%` }} />
            </div>
            <div class="activity-health-legend">
              <span><i class="settled" />{fmtCount(stats.settled)} settled</span>
              <span><i class="running" />{fmtCount(stats.running)} running</span>
              <span><i class="error" />{fmtCount(stats.errors)} errors</span>
            </div>
          </article>

        </section>

        <Card
          title="Filters"
          class="activity-filter-card"
          headerRight={(
            <span class={`activity-filter-count ${activeFilterCount ? "active" : ""}`.trim()}>
              {activeFilterCount ? `${activeFilterCount} active` : "All activity"}
            </span>
          )}
        >
          <div class="activity-filter-panel activity-filters">
            <div class="activity-filter-field">
              <span>Agent</span>
              <Select
                value={agentFilter}
                onChange={setAgentFilter}
                options={[
                  { value: "", label: "All agents" },
                  ...agents.map((agent) => ({ value: agent.name, label: agent.display_name || agent.name })),
                ]}
                ariaLabel="Filter by agent"
                leadingSlot={agentLeadingSlot}
                searchable
                class="activity-filter-select"
                menuWidth={260}
              />
            </div>
            <div class="activity-filter-field">
              <span>Status</span>
              <Select
                value={statusFilter}
                onChange={setStatusFilter}
                options={STATUS_OPTIONS}
                ariaLabel="Filter by status"
                leadingSlot={statusLeadingSlot}
                searchable={false}
                class="activity-filter-select"
                menuWidth={220}
              />
            </div>
            <div class="activity-filter-field activity-filter-date">
              <span>Date range</span>
              <DateRangePicker value={dateRange} onChange={setDateRange} class="activity-date-range" />
            </div>
            <div class="activity-filter-actions">
              {activeFilterCount > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setAgentFilter("");
                    setStatusFilter("");
                    setDateRange({ from: "", to: "" });
                  }}
                >
                  Reset
                </Button>
              )}
            </div>
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
          <Card title="Recent activity" class="activity-list-card" headerRight={<span class="activity-list-count">{fmtCount(items.length)} shown</span>}>
            <div class="activity-list">
              {items.map((item) => {
                const metaParts = activityMetaParts(item);
                const metricParts = activityMetricParts(item);
                return (
                  <article class="activity-row" data-status={item.status} key={item.id}>
                    <span class="activity-row-rail" aria-hidden="true" />
                    <AgentAvatar name={item.agent_name} label={item.agent_name} size={26} />
                    <div class="activity-row-main">
                      <div class="activity-row-titleline">
                        <div class="activity-title">
                          {activityTitle(item)}
                          {item.automation_trigger_type && item.mode !== "automation" && (
                            <span class="chip chip-trigger">
                              <Icon name="clock" size={10} /> Scheduled
                            </span>
                          )}
                        </div>
                        <StatusPill status={item.status} size="sm" />
                      </div>
                      <div class="activity-meta">
                        {metaParts.map((part) => <span key={part}>{part}</span>)}
                      </div>
                      {metricParts.length > 0 && (
                        <div class="activity-row-metrics" aria-label="Run metrics">
                          {metricParts.map((part) => (
                            <span class="activity-row-metric" key={part.key}>
                              <Icon name={part.icon} size={12} />
                              {part.label}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div class="activity-row-aside">
                      <span class="activity-time" title={fmtTime(item.started_at)}>{fmtAge(item.started_at)}</span>
                      {item.task_id && (
                        <a
                          class="activity-open-link"
                          href={`#/tasks/${taskRouteId({ id: item.task_id, task_key: item.task_key })}?run=${item.id}`}
                        >
                          Open
                        </a>
                      )}
                    </div>
                  </article>
                );
              })}
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
      </Page>
    </AppShell>
  );
}
