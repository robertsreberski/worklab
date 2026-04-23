// src/ui/src/routes/TaskDetail.jsx
import { useEffect, useState, useCallback } from "preact/hooks";
import { api } from "../lib/api.js";
import { useSSE } from "../lib/useSSE.js";
import { useRunStream } from "../lib/useRunStream.js";
import { useFormSave } from "../lib/useFormSave.js";
import { pushToast } from "../lib/toast.js";
import { CommentList } from "../components/CommentList.jsx";
import { EventTimeline } from "../components/EventTimeline.jsx";
import { ConfirmButton } from "../components/ConfirmButton.jsx";
import { SelectField } from "../components/SelectField.jsx";
import { selectHighlightedRunId } from "./taskDetailRuns.js";
import { StatusSignal } from "../components/StatusSignal.jsx";
import { AdvancedMeta } from "../components/AdvancedMeta.jsx";
import { EntityHeader } from "../components/EntityHeader.jsx";
import { TASK_STATUS_LABELS, STATUS_TONES, agentDisplayName } from "../lib/display.js";

const STATUS_LABELS = TASK_STATUS_LABELS;

const RUN_STATUS_CLASS = {
  running: "in_progress",
  complete: "done",
  error: "error",
  failed: "error",
  cancelled: "muted",
};

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

function formatDate(value) {
  if (!value) return null;
  return new Date(value).toLocaleString();
}

function formatDuration(ms) {
  if (ms == null) return null;
  const value = Number(ms);
  if (!Number.isFinite(value)) return null;
  if (value < 1000) return `${value}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function formatTokens(n) {
  if (n == null) return null;
  const value = Number(n);
  if (!Number.isFinite(value)) return null;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

function formatCost(value) {
  if (value == null) return null;
  const cost = Number(value);
  if (!Number.isFinite(cost)) return null;
  return `$${cost.toFixed(5)}`;
}

function runDuration(run) {
  if (run?.log?.duration_ms != null) return run.log.duration_ms;
  if (run?.ended_at && run?.started_at) return run.ended_at - run.started_at;
  return null;
}

function runStatusClass(status) {
  return RUN_STATUS_CLASS[status] || "muted";
}

function compactRunStats(run) {
  const log = run.log || {};
  const tokenText = log.input_tokens != null || log.output_tokens != null
    ? `in ${formatTokens(log.input_tokens || 0)} / out ${formatTokens(log.output_tokens || 0)}`
    : null;
  return [
    runDuration(run) != null ? formatDuration(runDuration(run)) : (run.status === "running" ? "running" : null),
    log.num_turns != null ? `${log.num_turns} turns` : null,
    tokenText,
    formatCost(log.cost_usd),
  ].filter(Boolean).join(" / ");
}

function RunStat({ label, value, title }) {
  if (value == null || value === "") return null;
  return (
    <div class="run-stat" title={title || String(value)}>
      <div class="run-stat-value">{value}</div>
      <div class="text-label">{label}</div>
    </div>
  );
}

function RunStatsStrip({ run, agentLabel }) {
  const log = run.log || {};
  return (
    <div class="run-stats-strip">
      <RunStat label="Mode" value={run.mode} />
      <RunStat label="Agent" value={agentLabel || run.agent_name} />
      <RunStat label="Started" value={formatDate(run.started_at)} />
      <RunStat label="Ended" value={formatDate(run.ended_at) || (run.status === "running" ? "Running" : "-")} />
      <RunStat label="Duration" value={formatDuration(runDuration(run)) || "-"} />
      <RunStat label="Turns" value={log.num_turns ?? "-"} />
      <RunStat label="Input" value={formatTokens(log.input_tokens) || "-"} />
      <RunStat label="Output" value={formatTokens(log.output_tokens) || "-"} />
      {log.cache_read_tokens > 0 && <RunStat label="Cache Read" value={formatTokens(log.cache_read_tokens)} />}
      {log.cache_creation_tokens > 0 && <RunStat label="Cache Write" value={formatTokens(log.cache_creation_tokens)} />}
      <RunStat label="Cost" value={formatCost(log.cost_usd) || "-"} />
      <RunStat label="Exit" value={run.exit_code ?? "-"} />
      {log.effort && <RunStat label="Effort" value={log.effort} />}
    </div>
  );
}

function RunTimelineCard({
  run,
  title,
  expanded = false,
  highlighted = false,
  subscribe = false,
  onToggle,
  journalSection,
  agentLabel,
}) {
  const [showRawEvents, setShowRawEvents] = useState(false);
  const shouldLoadEvents = Boolean(expanded || subscribe);
  const { events, loading } = useRunStream(shouldLoadEvents ? run?.id : null, {
    subscribe: Boolean(subscribe && shouldLoadEvents),
  });

  useEffect(() => {
    if (!expanded) setShowRawEvents(false);
  }, [expanded]);

  if (!run) return null;
  const stats = compactRunStats(run);
  const statusLabel = run.status || "unknown";

  function handleToggle(e) {
    const nextOpen = e.currentTarget.open;
    if (nextOpen !== expanded) onToggle?.(run.id, nextOpen);
  }

  return (
    <details
      open={expanded}
      onToggle={handleToggle}
      class={`run-card${highlighted ? " highlighted" : ""}`}
    >
      <summary>
        <div class="run-summary-main">
          <div class="run-summary-title">
            <strong>{title}</strong>
            {highlighted && <StatusSignal tone="blue" compact>Selected</StatusSignal>}
            <StatusSignal tone={STATUS_TONES[statusLabel] || runStatusClass(statusLabel)} compact>{statusLabel}</StatusSignal>
          </div>
          <span class="meta">
            {run.mode} / {agentLabel || run.agent_name} / {formatDate(run.started_at)}
          </span>
        </div>
        <div class="run-summary-side">
          {stats && <span class="meta">{stats}</span>}
          <span class="run-open-label">{expanded ? "Hide log" : "Open log"}</span>
        </div>
      </summary>
      <div class="run-card-body">
        <RunStatsStrip run={run} agentLabel={agentLabel} />
        <AdvancedMeta
          title="Run identifiers"
          items={[
            { label: "Run ID", value: run.id },
            { label: "Log ID", value: run.log?.id },
            { label: "Agent slug", value: run.agent_name },
            { label: "Model reference", value: run.log?.model },
          ]}
        />
        {loading ? (
          <div class="meta">Loading run events...</div>
        ) : (
          <EventTimeline events={events} streaming={run.status === "running"} />
        )}
        {journalSection && (
          <section class="run-journal" aria-label="Agent journal for this run">
            <div class="section-kicker">Journal</div>
            <h3 class="section-title">Agent notes from this run</h3>
            <pre class="code-panel">{journalSection}</pre>
          </section>
        )}
        {events.length > 0 && (
          <div class="run-raw-section">
            <button
              type="button"
              class="run-raw-toggle"
              aria-expanded={showRawEvents}
              onClick={() => setShowRawEvents((current) => !current)}
            >
              {showRawEvents ? "Hide raw events" : "Raw events"}
            </button>
            {showRawEvents && <pre class="run-raw-events">{JSON.stringify(events, null, 2)}</pre>}
          </div>
        )}
      </div>
    </details>
  );
}

export function TaskDetail({ id, runParam = null }) {
  const [data, setData] = useState(null);
  const [agents, setAgents] = useState([]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({});
  const [newComment, setNewComment] = useState("");
  const [highlightedRunId, setHighlightedRunId] = useState(runParam);
  const [expandedRunIds, setExpandedRunIds] = useState(() => new Set());
  const [runError, setRunError] = useState(null);
  const [journalSections, setJournalSections] = useState({});

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
    setEditing(false);
    setJournalSections({});
  }, [id, runParam]);

  useSSE("global", (evt) => {
    const taskChanged = evt.id === id;
    const runChanged = evt.taskId === id && (evt.type === "run_started" || evt.type === "run_ended");
    if (taskChanged || runChanged) reload();
    if (evt.type === "run_started" && evt.taskId === id) setHighlightedRunId(evt.runId);
  });

  useEffect(() => {
    const nextRunId = selectHighlightedRunId(data?.runs || [], highlightedRunId, {
      preserveMissingActive: Boolean(highlightedRunId),
    });
    if (nextRunId !== highlightedRunId) {
      setHighlightedRunId(nextRunId);
    }
  }, [data, highlightedRunId]);

  const expandedRunIdsKey = [...expandedRunIds].sort().join("|");
  const journalSectionsKey = Object.keys(journalSections).sort().join("|");
  useEffect(() => {
    const runs = data?.runs || [];
    let cancelled = false;
    for (const run of runs) {
      if (!expandedRunIds.has(run.id) || run.status === "running" || hasOwn(journalSections, run.id)) continue;
      api.getAgentJournal(run.agent_name, run.id)
        .then((r) => {
          if (!cancelled) {
            setJournalSections((current) => ({ ...current, [run.id]: r.section || null }));
          }
        })
        .catch(() => {
          if (!cancelled) {
            setJournalSections((current) => ({ ...current, [run.id]: null }));
          }
        });
    }
    return () => { cancelled = true; };
  }, [data?.runs, expandedRunIdsKey, journalSectionsKey]);

  const formSave = useFormSave(async (patch) => {
    await api.patchTask(id, patch);
    setEditing(false);
    reload();
  });

  if (!data) return <div class="surface-panel">Loading...</div>;
  if (data.notFound) return <div class="surface-panel">Task not found. <a href="#/tasks">Back</a></div>;
  const { task, comments } = data;
  const runs = data.runs || [];
  const latestRun = runs[0] || null;
  const runningRun = runs.find((run) => run.status === "running") || null;
  const agentOptions = agents.map((agent) => ({ value: agent.name, label: agent.display_name || agent.name }));
  const executorLabel = agentDisplayName(agents, task.executor_agent);
  const reviewerLabel = agentDisplayName(agents, task.reviewer_agent, "No reviewer");

  function toggleRun(runId, open) {
    setHighlightedRunId(runId);
    setExpandedRunIds((current) => {
      const next = new Set(current);
      if (open) next.add(runId);
      else next.delete(runId);
      return next;
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
      setExpandedRunIds((current) => new Set([...current, r.runId]));
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

  const canRun = task.executor_agent && (task.status === "todo" || task.status === "in_progress") && !runningRun;

  return (
    <div class="detail task-detail">
      <a href="#/tasks" class="back-link">Back to tasks</a>

      <EntityHeader
        eyebrow="Task"
        title={task.title}
        meta={(
          <>
            <StatusSignal tone={STATUS_TONES[task.status] || "muted"}>{STATUS_LABELS[task.status] || task.status}</StatusSignal>
            <span class="soft-meta">Executor {executorLabel}</span>
            <span class="soft-meta">Reviewer {reviewerLabel}</span>
            {task.retry_count > 0 && <span class="soft-meta">{task.retry_count} retries</span>}
            {latestRun && <StatusSignal tone={STATUS_TONES[latestRun.status] || "muted"} compact>Latest run {latestRun.status}</StatusSignal>}
            {task.error_text && <StatusSignal tone="red" compact>Error</StatusSignal>}
          </>
        )}
        actions={(
          <>
          <button class="primary" onClick={runNow} disabled={!canRun}>Run now</button>
          {runningRun && <button onClick={cancelRun} class="danger">Cancel run</button>}
          <button onClick={() => { setDraft(task); setEditing(true); formSave.clearError(); }}>Edit</button>
          <ConfirmButton class="danger" onConfirm={destroy} confirmLabel="Click again to delete">Delete</ConfirmButton>
          </>
        )}
      />

      {runError && <div class="surface-panel compact status-line error">{runError}</div>}
      {task.error_text && <div class="surface-panel compact status-line error">{task.error_text}</div>}
      {!task.executor_agent && <div class="surface-panel compact field-help">Set an executor agent to enable Run now.</div>}
      <AdvancedMeta title="Task identifiers" items={[{ label: "Task ID", value: task.id }]} />

      <div class="task-detail-grid">
        <div class="task-main-stack">
          <section class="surface-panel task-brief-panel">
            <div class="list-header">
              <div>
                <div class="section-kicker">Brief</div>
                <h3 class="section-title">Task context</h3>
              </div>
            </div>

            {!editing ? (
              <>
                <div class="field">
                  <label>Description</label>
                  <div class="detail-copy">{task.description || <span class="meta">No description.</span>}</div>
                </div>
                <div class="field">
                  <label>Instructions</label>
                  <pre class="code-panel">{task.instructions || "(none)"}</pre>
                </div>
              </>
            ) : (
              <>
                <div class="form-grid">
                  <div class="field span-2">
                    <label>Title</label>
                    <input value={draft.title} onInput={(e) => setDraft({ ...draft, title: e.target.value })} />
                  </div>
                  <div class="field span-2">
                    <label>Description</label>
                    <textarea rows="4" value={draft.description} onInput={(e) => setDraft({ ...draft, description: e.target.value })} />
                  </div>
                  <div class="field span-2">
                    <label>Instructions</label>
                    <textarea rows="8" value={draft.instructions} onInput={(e) => setDraft({ ...draft, instructions: e.target.value })} />
                  </div>
                  <div class="field">
                    <label>Executor agent</label>
                    <SelectField
                      value={draft.executor_agent || ""}
                      options={[{ value: "", label: "Unassigned" }, ...agentOptions]}
                      onChange={(value) => setDraft({ ...draft, executor_agent: value || null })}
                    />
                  </div>
                  <div class="field">
                    <label>Reviewer agent</label>
                    <SelectField
                      value={draft.reviewer_agent || ""}
                      options={[{ value: "", label: "None" }, ...agentOptions]}
                      onChange={(value) => setDraft({ ...draft, reviewer_agent: value || null })}
                    />
                  </div>
                </div>
                <div class="form-actions">
                  <button class="primary" onClick={() => formSave.save(draft).catch(() => {})} disabled={formSave.saving}>
                    {formSave.saving ? "Saving..." : "Save"}
                  </button>
                  <button onClick={() => { setEditing(false); formSave.clearError(); }} disabled={formSave.saving}>Cancel</button>
                </div>
                {formSave.error && <div class="form-error" role="alert">Save failed: {formSave.error}</div>}
              </>
            )}
          </section>

          <section class="surface-panel task-comments-panel">
            <div class="list-header">
              <div>
                <div class="section-kicker">Outcome</div>
                <h3 class="section-title">Comments</h3>
              </div>
              <span class="soft-meta">{comments.length} total</span>
            </div>
            <CommentList comments={comments} />
            <form onSubmit={addComment} class="comment-form">
              <div class="field">
                <textarea rows="4" placeholder="Add a comment..." value={newComment} onInput={(e) => setNewComment(e.target.value)} />
              </div>
              <button type="submit" class="primary" disabled={!newComment.trim()}>Post</button>
            </form>
          </section>
        </div>

        <aside class="task-side-stack">
          <section class="surface-panel run-list-panel">
            <div class="list-header">
              <div>
                <div class="section-kicker">Runs</div>
                <h3 class="section-title">Execution log</h3>
              </div>
              {runs.length > 0 && <span class="soft-meta">{runs.length} total</span>}
            </div>
            {runs.length === 0 ? (
              <div class="meta">No runs yet.</div>
            ) : (
              <div class="run-list">
                {runs.slice(0, 6).map((run, index) => (
                  <RunTimelineCard
                    key={run.id}
                    run={run}
                    title={index === 0 ? "Latest run" : "Previous run"}
                    expanded={expandedRunIds.has(run.id)}
                    highlighted={run.id === highlightedRunId}
                    subscribe={run.status === "running" && expandedRunIds.has(run.id)}
                    onToggle={toggleRun}
                    journalSection={journalSections[run.id]}
                    agentLabel={agentDisplayName(agents, run.agent_name, run.agent_name)}
                  />
                ))}
                {runs.length > 6 && <div class="meta">Showing latest 6 runs.</div>}
              </div>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
