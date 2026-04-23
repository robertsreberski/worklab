import { useEffect, useMemo, useState, useCallback } from "preact/hooks";
import { api } from "../lib/api.js";
import { useSSE } from "../lib/useSSE.js";
import { useRunStream } from "../lib/useRunStream.js";
import { useLiveTicker } from "../lib/useLiveTicker.js";
import { AppShell } from "../components/AppShell.jsx";
import { AgentAvatar } from "../components/AgentAvatar.jsx";
import { SearchField } from "../components/SearchField.jsx";
import { Icon } from "../components/Icon.jsx";
import { StatusPill, StatusDot, statusMeta } from "../components/primitives/StatusPill.jsx";
import { LivePulse } from "../components/primitives/LivePulse.jsx";
import { ToolToken } from "../components/primitives/ToolToken.jsx";
import { agentDisplayName } from "../lib/display.js";

const STATUS_ORDER = ["in_progress", "in_review", "todo", "error", "done"];
const STATUS_DEFS = [
  { id: "todo", label: "Todo" },
  { id: "in_progress", label: "In progress" },
  { id: "in_review", label: "In review" },
  { id: "done", label: "Done" },
];

function formatAge(value) {
  if (!value) return "";
  const ms = Date.now() - Number(value);
  if (ms < 60_000) return "now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  if (ms < 86_400_000 * 7) return `${Math.floor(ms / 86_400_000)}d`;
  return new Date(Number(value)).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function taskIdDisplay(id) {
  const raw = String(id || "");
  if (raw.startsWith("task_")) return raw.slice(5, 11).toUpperCase();
  return raw.slice(0, 6).toUpperCase();
}

function FilterBar({ statusFilter, setStatusFilter, counts, total, query, onQuery }) {
  return (
    <div class="commander-filter">
      <SearchField
        value={query}
        onInput={(e) => onQuery(e.target.value)}
        placeholder="Search tasks..."
        shortcut="/"
      />
      <div class="filter-divider" />
      {STATUS_DEFS.map((s) => {
        const active = statusFilter === s.id;
        const meta = statusMeta(s.id);
        return (
          <button
            key={s.id}
            type="button"
            class={`filter-pill ${active ? "active" : ""}`}
            onClick={() => setStatusFilter(active ? null : s.id)}
          >
            <span class="glyph" style={{ color: meta.color }}>{meta.icon}</span>
            {s.label}
            <span class="count">{counts[s.id] || 0}</span>
          </button>
        );
      })}
      <div style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 8 }}>
        <span style={{ color: "var(--muted)", fontSize: 12 }}>{total} tasks</span>
        <a href="#/tasks/new" class="button primary small">
          <Icon name="plus" size={13} />
          New task
        </a>
      </div>
    </div>
  );
}

function CommanderRow({ task, agents, selected, onOpen }) {
  const running = task.status === "in_progress" || task.status === "in_review";
  const { events } = useRunStream(running ? task.running_run_id || null : null, { subscribe: running });
  const recentEvents = useMemo(() => {
    if (!running) return [];
    return (events || []).slice(-6);
  }, [events, running]);
  const event = useLiveTicker(recentEvents, { running, intervalMs: 2200 });
  const statusMeta_ = statusMeta(task.status);

  const executorLabel = agentDisplayName(agents, task.executor_agent, "Unassigned");
  const reviewerLabel = agentDisplayName(agents, task.reviewer_agent, null);

  return (
    <a
      href={`#/tasks/${task.id}`}
      class={`commander-row ${selected ? "selected" : ""} ${running && event ? "running" : ""}`}
      onClick={onOpen}
    >
      <div class="commander-cell-checkbox">
        <span class="commander-checkbox" aria-hidden="true" />
      </div>
      <span class="commander-cell-id">{taskIdDisplay(task.id)}</span>
      <span class="commander-cell-status">
        {running ? (
          <LivePulse color={statusMeta_.color} size={7} />
        ) : (
          <StatusDot status={task.status} size={8} />
        )}
      </span>
      <div class="commander-cell-title">
        <div class="commander-cell-title-row">
          <span class="commander-title">{task.title}</span>
          {task.error_text && (
            <span class="chip chip-error">
              <Icon name="alert-triangle" size={10} />
              {task.retry_count || 1} retries
            </span>
          )}
          {!task.executor_agent && task.status !== "done" && (
            <span class="chip chip-warn">Needs executor</span>
          )}
        </div>
        {running && event && (
          <div class="commander-live-line" key={`${task.id}-${event.ts || event.t || 0}`}>
            <ToolToken event={event} compact />
          </div>
        )}
      </div>
      <div class="commander-cell-deps">
        {Number(task.priority) > 0 && <span class="chip chip-warn">P{task.priority}</span>}
      </div>
      <div class="commander-cell-assignees">
        <AgentAvatar name={task.executor_agent} label={executorLabel} size={18} title={`Executor: ${executorLabel}`} />
        {task.reviewer_agent && (
          <>
            <Icon name="arrow-right" size={10} class="agent-pair-arrow" />
            <AgentAvatar name={task.reviewer_agent} label={reviewerLabel} size={18} title={`Reviewer: ${reviewerLabel}`} />
          </>
        )}
      </div>
      <StatusPill status={task.status} size="sm" />
      <div class="commander-cell-age">{formatAge(task.updated_at)}</div>
    </a>
  );
}

export function Commander() {
  const [tasks, setTasks] = useState([]);
  const [agents, setAgents] = useState([]);
  const [statusFilter, setStatusFilter] = useState(null);
  const [query, setQuery] = useState("");

  const reload = useCallback(() => {
    api.listTasks().then((r) => setTasks(r.tasks || [])).catch(() => setTasks([]));
  }, []);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    api.listAgents().then((r) => setAgents(r.agents || [])).catch(() => setAgents([]));
  }, []);
  useSSE("global", (evt) => {
    if (["task_created", "task_updated", "task_deleted", "run_started", "run_ended"].includes(evt.type)) reload();
  });

  const counts = useMemo(() => {
    const c = {};
    for (const t of tasks) c[t.status] = (c[t.status] || 0) + 1;
    return c;
  }, [tasks]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tasks.filter((t) => {
      if (statusFilter && t.status !== statusFilter) return false;
      if (!q) return true;
      return (
        t.title?.toLowerCase().includes(q) ||
        t.description?.toLowerCase().includes(q) ||
        t.id?.toLowerCase().includes(q) ||
        t.executor_agent?.toLowerCase().includes(q) ||
        t.reviewer_agent?.toLowerCase().includes(q)
      );
    });
  }, [tasks, statusFilter, query]);

  const grouped = useMemo(() => {
    return STATUS_ORDER
      .map((status) => ({
        status,
        meta: statusMeta(status),
        tasks: filtered.filter((t) => t.status === status),
      }))
      .filter((g) => g.tasks.length > 0);
  }, [filtered]);

  const activeCount = (counts.in_progress || 0) + (counts.in_review || 0);
  const blockedCount = tasks.filter((t) => t.error_text).length;

  const headerMeta = (
    <>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <LivePulse color={activeCount > 0 ? "var(--green)" : "var(--muted)"} size={6} />
        {activeCount} active
      </span>
      <span class="dot">·</span>
      <span>{tasks.length} total</span>
      {blockedCount > 0 && (
        <>
          <span class="dot">·</span>
          <span style={{ color: "var(--red)" }}>{blockedCount} blocked</span>
        </>
      )}
    </>
  );

  return (
    <AppShell route="tasks" title="Tasks" headerMeta={headerMeta}>
      <div class="commander">
        <FilterBar
          statusFilter={statusFilter}
          setStatusFilter={setStatusFilter}
          counts={counts}
          total={filtered.length}
          query={query}
          onQuery={setQuery}
        />
        {grouped.length === 0 ? (
          <div class="commander-empty">
            {query || statusFilter ? (
              <>No tasks match your filters.</>
            ) : (
              <>
                <p>No tasks yet.</p>
                <a href="#/tasks/new" class="button primary">
                  <Icon name="plus" size={13} />
                  Create your first task
                </a>
              </>
            )}
          </div>
        ) : (
          <div class="commander-list wl-hide-scrollbar">
            {grouped.map((group) => (
              <div key={group.status} class="commander-group">
                <div class="commander-group-header">
                  <span class="group-icon" style={{ color: group.meta.color }}>{group.meta.icon}</span>
                  {group.meta.label}
                  <span class="group-count">{group.tasks.length}</span>
                </div>
                {group.tasks.map((task) => (
                  <CommanderRow
                    key={task.id}
                    task={task}
                    agents={agents}
                    selected={false}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
