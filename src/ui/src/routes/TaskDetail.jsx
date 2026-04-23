import { useEffect, useState, useCallback } from "preact/hooks";
import { api } from "../lib/api.js";
import { useSSE } from "../lib/useSSE.js";
import { useRunStream } from "../lib/useRunStream.js";
import { pushToast } from "../lib/toast.js";
import { AppShell } from "../components/AppShell.jsx";
import { CommentList } from "../components/CommentList.jsx";
import { EventTimeline } from "../components/EventTimeline.jsx";
import { ConfirmButton } from "../components/ConfirmButton.jsx";
import { AgentAvatar } from "../components/AgentAvatar.jsx";
import { Icon } from "../components/Icon.jsx";
import { StatusPill } from "../components/primitives/StatusPill.jsx";
import { LivePulse } from "../components/primitives/LivePulse.jsx";
import { ShimmerBar } from "../components/primitives/ShimmerBar.jsx";
import { selectHighlightedRunId } from "./taskDetailRuns.js";
import { agentDisplayName } from "../lib/display.js";

function formatDate(v) { return v ? new Date(v).toLocaleString() : null; }
function formatDuration(ms) {
  if (ms == null) return null;
  const v = Number(ms);
  if (!Number.isFinite(v)) return null;
  if (v < 1000) return `${v}ms`;
  if (v < 60_000) return `${(v / 1000).toFixed(1)}s`;
  const m = Math.floor(v / 60_000);
  const s = Math.round((v % 60_000) / 1000);
  return `${m}m ${s}s`;
}
function formatTokens(n) {
  if (n == null) return null;
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
}
function formatCost(v) {
  if (v == null) return null;
  const c = Number(v);
  if (!Number.isFinite(c)) return null;
  return `$${c.toFixed(4)}`;
}
function runDuration(run) {
  if (run?.log?.duration_ms != null) return run.log.duration_ms;
  if (run?.ended_at && run?.started_at) return run.ended_at - run.started_at;
  return null;
}

function RunCard({ run, expanded, onToggle, agentLabel, subscribe }) {
  const { events, loading } = useRunStream(expanded || subscribe ? run?.id : null, { subscribe });
  const log = run?.log || {};

  function handleToggle(e) {
    onToggle?.(run.id, e.currentTarget.open);
  }

  return (
    <details
      open={expanded}
      onToggle={handleToggle}
      class="run-card"
    >
      <summary style={{ cursor: "pointer", listStyle: "none" }}>
        <div class="run-summary">
          <div class="run-summary-main">
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <StatusPill status={run.status} size="sm" />
              <span class="run-summary-title">{formatDate(run.started_at) || "Run"}</span>
            </div>
            <div class="muted" style={{ fontSize: 11.5 }}>
              {run.mode} · {agentLabel || run.agent_name}
              {formatDuration(runDuration(run)) && ` · ${formatDuration(runDuration(run))}`}
              {log.cost_usd != null && ` · ${formatCost(log.cost_usd)}`}
              {log.num_turns != null && ` · ${log.num_turns} turns`}
            </div>
          </div>
          <div class="run-summary-side">
            <span>{expanded ? "Hide" : "Open"}</span>
          </div>
        </div>
      </summary>
      <div style={{ marginTop: 12 }}>
        {loading ? (
          <div class="muted" style={{ fontSize: 12 }}>Loading events...</div>
        ) : (
          <EventTimeline events={events} streaming={run.status === "running"} />
        )}
      </div>
    </details>
  );
}

export function TaskDetail({ id, runParam = null }) {
  const [data, setData] = useState(null);
  const [agents, setAgents] = useState([]);
  const [newComment, setNewComment] = useState("");
  const [highlightedRunId, setHighlightedRunId] = useState(runParam);
  const [expandedRunIds, setExpandedRunIds] = useState(() => new Set());
  const [runError, setRunError] = useState(null);

  const reload = useCallback(() => {
    api.getTask(id).then(setData).catch(() => setData({ notFound: true }));
  }, [id]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    api.listAgents().then((r) => setAgents(r.agents || [])).catch(() => setAgents([]));
  }, []);

  useEffect(() => {
    setHighlightedRunId(runParam || null);
    setExpandedRunIds(new Set());
    setRunError(null);
  }, [id, runParam]);

  useSSE("global", (evt) => {
    const taskChanged = evt.id === id;
    const runChanged = evt.taskId === id && (evt.type === "run_started" || evt.type === "run_ended");
    if (taskChanged || runChanged) reload();
    if (evt.type === "run_started" && evt.taskId === id) setHighlightedRunId(evt.runId);
  });

  useEffect(() => {
    const next = selectHighlightedRunId(data?.runs || [], highlightedRunId, {
      preserveMissingActive: Boolean(highlightedRunId),
    });
    if (next !== highlightedRunId) setHighlightedRunId(next);
  }, [data, highlightedRunId]);

  if (!data) {
    return (
      <AppShell route="tasks" title="Loading...">
        <div class="page-wrap"><div style={{ color: "var(--muted)" }}>Loading task...</div></div>
      </AppShell>
    );
  }
  if (data.notFound) {
    return (
      <AppShell route="tasks" title="Not found">
        <div class="page-wrap">
          <div class="empty-state">
            <h3>Task not found</h3>
            <p>This task may have been deleted.</p>
            <a href="#/tasks" class="button primary">Back to tasks</a>
          </div>
        </div>
      </AppShell>
    );
  }

  const { task, comments = [] } = data;
  const runs = data.runs || [];
  const latestRun = runs[0] || null;
  const runningRun = runs.find((r) => r.status === "running") || null;

  const executorLabel = agentDisplayName(agents, task.executor_agent, "Unassigned");
  const reviewerLabel = agentDisplayName(agents, task.reviewer_agent, null);

  function toggleRun(runId, open) {
    setHighlightedRunId(runId);
    setExpandedRunIds((s) => {
      const n = new Set(s);
      if (open) n.add(runId); else n.delete(runId);
      return n;
    });
  }

  async function addComment(e) {
    e.preventDefault();
    if (!newComment.trim()) return;
    try {
      await api.addComment(id, newComment.trim());
      setNewComment("");
    } catch (err) {
      pushToast(`Could not post comment: ${err.message}`, { variant: "error" });
    }
  }

  async function destroy() {
    try {
      await api.deleteTask(id);
      window.location.hash = "#/tasks";
    } catch (err) {
      pushToast(`Delete failed: ${err.message}`, { variant: "error" });
    }
  }

  async function runNow() {
    setRunError(null);
    try {
      const r = await api.runTask(id);
      setHighlightedRunId(r.runId);
      setExpandedRunIds((s) => new Set([...s, r.runId]));
      reload();
    } catch (err) {
      setRunError(err.message);
    }
  }

  async function cancelRun() {
    try {
      await api.cancelTask(id);
    } catch (err) {
      setRunError(err.message);
    }
  }

  const canRun = task.executor_agent
    && (task.status === "todo" || task.status === "in_progress")
    && !runningRun;

  const headerActions = (
    <>
      {runningRun ? (
        <button class="button danger" onClick={cancelRun}>
          <Icon name="stop" size={13} />
          Cancel run
        </button>
      ) : (
        <button class="button primary" onClick={runNow} disabled={!canRun}>
          <Icon name="play" size={13} />
          Run now
        </button>
      )}
      <a class="button ghost" href={`#/tasks/${id}/edit`}>
        <Icon name="settings" size={13} />
        Edit
      </a>
      <ConfirmButton class="button danger" onConfirm={destroy} confirmLabel="Click again to delete">Delete</ConfirmButton>
    </>
  );

  return (
    <AppShell route="tasks" title={task.title} headerActions={headerActions}>
      <div class="task-detail">
        <div class="task-detail-main">
          <div class="task-breadcrumb">
            <a href="#/tasks">Tasks</a>
            <span class="sep">/</span>
            <span>{task.id}</span>
          </div>

          <section class="task-hero">
            <div class="task-hero-top">
              <h1 class="task-hero-title">{task.title}</h1>
            </div>
            <div class="task-hero-meta">
              <StatusPill status={task.status} />
              {task.error_text && (
                <span class="chip chip-error">
                  <Icon name="alert-triangle" size={10} />
                  Error
                </span>
              )}
              {Number(task.priority) > 0 && (
                <span class="chip chip-warn">P{task.priority}</span>
              )}
              {task.retry_count > 0 && (
                <span class="chip">{task.retry_count} retries</span>
              )}
            </div>
          </section>

          {runError && <div class="form-error">{runError}</div>}
          {task.error_text && <div class="form-error">{task.error_text}</div>}

          {(task.description || task.instructions) && (
            <section class="surface-panel">
              <div class="section-kicker">Brief</div>
              {task.description && (
                <div class="task-description" style={{ marginBottom: task.instructions ? 16 : 0 }}>
                  {task.description}
                </div>
              )}
              {task.instructions && (
                <>
                  <div class="section-kicker" style={{ marginTop: 12 }}>Instructions</div>
                  <pre class="code-panel" style={{ marginTop: 4 }}>{task.instructions}</pre>
                </>
              )}
            </section>
          )}

          {runningRun && (
            <section class="surface-panel">
              <div class="task-live-header">
                <LivePulse color="var(--yellow)" size={7} />
                <span>Running</span>
                <span class="muted">·</span>
                <span class="muted">{agentDisplayName(agents, runningRun.agent_name, runningRun.agent_name)}</span>
              </div>
              <ShimmerBar height={2} />
              <div style={{ marginTop: 10 }}>
                <RunCard
                  run={runningRun}
                  expanded
                  subscribe
                  onToggle={toggleRun}
                  agentLabel={agentDisplayName(agents, runningRun.agent_name, runningRun.agent_name)}
                />
              </div>
            </section>
          )}

          <section class="surface-panel">
            <div class="section-kicker">Runs</div>
            <h3 style={{ margin: "0 0 8px" }}>Execution log</h3>
            {runs.length === 0 ? (
              <div class="muted" style={{ fontSize: 12 }}>No runs yet.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {runs.slice(0, 8).map((run) => (
                  <RunCard
                    key={run.id}
                    run={run}
                    expanded={expandedRunIds.has(run.id)}
                    onToggle={toggleRun}
                    subscribe={run.status === "running" && expandedRunIds.has(run.id)}
                    agentLabel={agentDisplayName(agents, run.agent_name, run.agent_name)}
                  />
                ))}
                {runs.length > 8 && <div class="muted" style={{ fontSize: 12 }}>Showing latest 8 runs.</div>}
              </div>
            )}
          </section>

          <section class="surface-panel">
            <div class="section-kicker">Activity</div>
            <h3 style={{ margin: "0 0 8px" }}>Comments</h3>
            <CommentList comments={comments} />
            <form onSubmit={addComment} style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
              <textarea
                class="form-input"
                rows="3"
                placeholder="Add a comment..."
                value={newComment}
                onInput={(e) => setNewComment(e.target.value)}
                style={{ fontFamily: "var(--sans)", fontSize: 13 }}
              />
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button type="submit" class="button primary" disabled={!newComment.trim()}>
                  Post
                </button>
              </div>
            </form>
          </section>
        </div>

        <aside class="task-detail-rail">
          <div class="rail-card">
            <h4>Agents</h4>
            <div class="rail-row">
              <span class="label">Executor</span>
              <span class="value">
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <AgentAvatar name={task.executor_agent} label={executorLabel} size={20} />
                  <span>{executorLabel}</span>
                </span>
              </span>
            </div>
            {task.reviewer_agent && (
              <div class="rail-row">
                <span class="label">Reviewer</span>
                <span class="value">
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <AgentAvatar name={task.reviewer_agent} label={reviewerLabel} size={20} />
                    <span>{reviewerLabel}</span>
                  </span>
                </span>
              </div>
            )}
          </div>

          <div class="rail-card">
            <h4>Timeline</h4>
            <div class="rail-row">
              <span class="label">Created</span>
              <span class="value mono" style={{ fontSize: 11 }}>{formatDate(task.created_at)}</span>
            </div>
            <div class="rail-row">
              <span class="label">Updated</span>
              <span class="value mono" style={{ fontSize: 11 }}>{formatDate(task.updated_at)}</span>
            </div>
            {task.completed_at && (
              <div class="rail-row">
                <span class="label">Completed</span>
                <span class="value mono" style={{ fontSize: 11 }}>{formatDate(task.completed_at)}</span>
              </div>
            )}
          </div>

          {latestRun && latestRun.log && (
            <div class="rail-card">
              <h4>Latest run</h4>
              <div class="metric-grid">
                <div class="metric">
                  <div class="label">Duration</div>
                  <div class="value">{formatDuration(runDuration(latestRun)) || "—"}</div>
                </div>
                <div class="metric">
                  <div class="label">Turns</div>
                  <div class="value">{latestRun.log.num_turns ?? "—"}</div>
                </div>
                <div class="metric">
                  <div class="label">Tokens in</div>
                  <div class="value">{formatTokens(latestRun.log.input_tokens) || "—"}</div>
                </div>
                <div class="metric">
                  <div class="label">Tokens out</div>
                  <div class="value">{formatTokens(latestRun.log.output_tokens) || "—"}</div>
                </div>
                <div class="metric" style={{ gridColumn: "span 2" }}>
                  <div class="label">Cost</div>
                  <div class="value">{formatCost(latestRun.log.cost_usd) || "$0"}</div>
                </div>
              </div>
            </div>
          )}

          {(task.tags || []).length > 0 && (
            <div class="rail-card">
              <h4>Tags</h4>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {(task.tags || []).map((t) => (
                  <span key={t} class="tag">{t}</span>
                ))}
              </div>
            </div>
          )}
        </aside>
      </div>
    </AppShell>
  );
}
