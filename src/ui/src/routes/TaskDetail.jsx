// §6.3 TaskDetail — deep view of one task.
// Two-column layout. Hero with StatusMenu + primary action cluster. Stuck-task
// Banner (§5.2). LiveRunPanel while streaming. Activity feed. Previous runs.
// Rail: Agents, Details (KeyValueList), Tags, Actions.
// Error chip (§5.3) derived from last_run.status === 'error'.

import { useEffect, useMemo, useState, useCallback } from "preact/hooks";
import { api } from "../lib/api.js";
import { useSSE } from "../lib/useSSE.js";
import { useRunStream } from "../lib/useRunStream.js";
import { pushToast } from "../lib/toast.js";
import { useGlobalShortcuts } from "../lib/useGlobalShortcuts.js";
import { agentDisplayName } from "../lib/display.js";
import { selectHighlightedRunId } from "./taskDetailRuns.js";

import { AppShell } from "../components/AppShell.jsx";
import { Breadcrumb } from "../components/primitives/Breadcrumb.jsx";
import { StatusPill } from "../components/primitives/StatusPill.jsx";
import { LivePulse } from "../components/primitives/LivePulse.jsx";
import { Button } from "../components/primitives/Button.jsx";
import { Icon } from "../components/Icon.jsx";
import { AgentAvatar } from "../components/AgentAvatar.jsx";
import { CommentList } from "../components/CommentList.jsx";
import { EventTimeline } from "../components/EventTimeline.jsx";
import { ConfirmButton } from "../components/ConfirmButton.jsx";
import { Card } from "../components/Card.jsx";
import { Chip } from "../components/primitives/Chip.jsx";
import { Banner } from "../components/Banner.jsx";
import { KeyValueList } from "../components/KeyValueList.jsx";
import { Metric } from "../components/Metric.jsx";
import { LoadingState } from "../components/LoadingState.jsx";
import { EmptyState } from "../components/EmptyState.jsx";
import { LiveRunPanel } from "../components/LiveRunPanel.jsx";
import { StatusMenu } from "../components/StatusMenu.jsx";
import { Modal } from "../components/Modal.jsx";
import { Textarea } from "../components/primitives/Textarea.jsx";
import { Select } from "../components/primitives/Select.jsx";
import { MarkdownContent } from "../components/Markdown.jsx";
import { navigateHash } from "../lib/navigation.js";

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
  return (
    <details open={expanded} onToggle={(e) => onToggle?.(run.id, e.currentTarget.open)} class="run-card">
      <summary class="run-card-summary">
        <div class="run-summary">
          <div class="run-summary-main">
            <div class="run-summary-status">
              <StatusPill status={run.status} size="sm" />
              <span class="run-summary-title">{formatDate(run.started_at) || "Run"}</span>
            </div>
            <div class="run-summary-meta">
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
      <div class="run-card-events">
        {loading ? (
          <div class="run-card-events-loading">Loading events…</div>
        ) : (
          <EventTimeline events={events} streaming={run.status === "running"} />
        )}
      </div>
    </details>
  );
}

// §6.3 Activity feed: client-side merge of comments[] and runs[] milestones.
function buildActivity({ comments = [], runs = [] }) {
  const items = [];
  for (const c of comments) {
    items.push({
      type: "comment",
      at: c.created_at || 0,
      author: c.author,
      body: c.body || c.content || "",
      id: `c-${c.id || c.created_at}`,
    });
  }
  for (const r of runs) {
    if (r.started_at) {
      items.push({
        type: "run_started",
        at: r.started_at,
        agent: r.agent_name,
        runId: r.id,
        id: `rs-${r.id}`,
      });
    }
    if (r.ended_at) {
      items.push({
        type: r.status === "error" ? "run_failed" : "run_completed",
        at: r.ended_at,
        agent: r.agent_name,
        runId: r.id,
        status: r.status,
        id: `re-${r.id}`,
      });
    }
  }
  items.sort((a, b) => (b.at || 0) - (a.at || 0));
  return items;
}

export function TaskDetail({ id, runParam = null }) {
  const [data, setData] = useState(null);
  const [agents, setAgents] = useState([]);
  const [newComment, setNewComment] = useState("");
  const [highlightedRunId, setHighlightedRunId] = useState(runParam);
  const [expandedRunIds, setExpandedRunIds] = useState(() => new Set());
  const [runError, setRunError] = useState(null);
  const [statusModal, setStatusModal] = useState(null); // pending transition
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [showOlderActivity, setShowOlderActivity] = useState(false);

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

  const task = data?.task;
  const runs = data?.runs || [];
  const comments = data?.comments || [];
  const latestRun = runs[0] || null;
  const runningRun = runs.find((r) => r.status === "running") || null;
  const lastFinishedRun = runs.find((r) => r.status && r.status !== "running") || null;
  const hasLastRunError = lastFinishedRun?.status === "error";
  // §5.2 stuck-task: requires backend is_locked field. Until it ships, we do
  // NOT render the banner (prevents false positives).
  const showStuckBanner =
    task?.status === "in_progress" && task?.is_locked === false;

  const activity = useMemo(
    () => buildActivity({ comments, runs }),
    [comments, runs]
  );
  const visibleActivity = showOlderActivity ? activity : activity.slice(0, 12);

  const executorLabel = task ? agentDisplayName(agents, task.executor_agent, "Unassigned") : "";
  const reviewerLabel = task ? agentDisplayName(agents, task.reviewer_agent, null) : null;
  const unresolvedBlockedBy = useMemo(
    () => (task?.blocked_by || []).filter((entry) => entry.status !== "done"),
    [task],
  );
  const agentOptions = useMemo(
    () => [
      { value: "", label: "Unassigned" },
      ...agents.map((agent) => ({ value: agent.name, label: agent.display_name || agent.name })),
    ],
    [agents],
  );

  function toggleRun(runId, open) {
    setHighlightedRunId(runId);
    setExpandedRunIds((s) => {
      const n = new Set(s);
      if (open) n.add(runId); else n.delete(runId);
      return n;
    });
  }

  async function addComment(e) {
    e?.preventDefault?.();
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
      pushToast("Task deleted", { variant: "success" });
      navigateHash("#/tasks");
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
      pushToast("Run started", { variant: "success" });
    } catch (err) {
      setRunError(err.message);
      pushToast(`Run failed: ${err.message}`, { variant: "error" });
    }
  }

  async function cancelRun() {
    try { await api.cancelTask(id); pushToast("Run cancelled", { variant: "info" }); }
    catch (err) { setRunError(err.message); pushToast(`Cancel failed: ${err.message}`, { variant: "error" }); }
  }

  async function resetToTodo() {
    try {
      await api.patchTask(id, { status: "todo" });
      reload();
      pushToast("Reset to Todo", { variant: "success" });
    } catch (err) {
      pushToast(`Reset failed: ${err.message}`, { variant: "error" });
    }
  }

  async function retryStuck() {
    try {
      await api.patchTask(id, { status: "todo" });
      const r = await api.runTask(id);
      setHighlightedRunId(r.runId);
      setExpandedRunIds((s) => new Set([...s, r.runId]));
      reload();
      pushToast("Run retried", { variant: "success" });
    } catch (err) {
      pushToast(`Retry failed: ${err.message}`, { variant: "error" });
    }
  }

  async function applyStatusTransition(t) {
    try {
      if (t.to === "in_progress" && t.from === "todo") {
        await runNow();
        return;
      }
      await api.patchTask(id, { status: t.to });
      reload();
      pushToast(`Status → ${t.to}`, { variant: "success" });
    } catch (err) {
      pushToast(`Status change failed: ${err.message}`, { variant: "error" });
    }
  }

  function onStatusChoose(t) {
    if (t.confirm) setStatusModal(t);
    else applyStatusTransition(t);
  }

  async function updateAssignee(role, value) {
    try {
      await api.patchTask(id, { [role]: value || null });
      pushToast("Assignment updated", { variant: "success" });
      reload();
    } catch (error) {
      pushToast(`Assignment failed: ${error.message}`, { variant: "error" });
    }
  }

  // §6.3 primary action cluster per status
  const canRun = task?.executor_agent && task.status === "todo" && unresolvedBlockedBy.length === 0;
  const runDisabledReason = !task?.executor_agent
    ? "Assign an executor to run"
    : unresolvedBlockedBy.length > 0
      ? `Blocked by ${unresolvedBlockedBy.map((entry) => entry.title).join(", ")}`
      : undefined;
  const primaryAction = (() => {
    if (!task) return null;
    if (runningRun) {
      return (
        <Button variant="destructive" iconLeft={<Icon name="stop" size={13} />} onClick={cancelRun}>
          Cancel run
        </Button>
      );
    }
    if (showStuckBanner) {
      return (
        <Button variant="primary" iconLeft={<Icon name="refresh-cw" size={13} />} onClick={retryStuck}>
          Retry
        </Button>
      );
    }
    if (task.status === "todo") {
      return (
        <Button
          variant="primary"
          iconLeft={<Icon name="play" size={13} />}
          onClick={runNow}
          disabled={!canRun}
          title={runDisabledReason}
        >
          Run now
        </Button>
      );
    }
    if (task.status === "in_review") {
      return (
        <>
          <Button variant="primary" onClick={() => applyStatusTransition({ from: "in_review", to: "done" })}>
            Approve
          </Button>
          <Button variant="secondary" onClick={() => applyStatusTransition({ from: "in_review", to: "in_progress" })}>
            Send back
          </Button>
        </>
      );
    }
    if (task.status === "done") {
      return (
        <Button variant="secondary" onClick={() => applyStatusTransition({ from: "done", to: "todo" })}>
          Reopen
        </Button>
      );
    }
    return null;
  })();

  const headerActions = task && (
    <>
      {primaryAction}
      <Button variant="ghost" iconLeft={<Icon name="settings" size={13} />} onClick={() => { navigateHash(`#/tasks/${id}/edit`); }}>
        Edit
      </Button>
      <Button variant="destructive" iconLeft={<Icon name="trash" size={13} />} onClick={() => setDeleteOpen(true)}>
        Delete
      </Button>
    </>
  );

  // §5.9 keyboard: ⌘Enter triggers primary, E opens edit
  useGlobalShortcuts({
    cmdenter: (e) => {
      e.preventDefault();
      const activeTag = document.activeElement?.tagName?.toLowerCase?.() || "";
      if ((activeTag === "textarea" || activeTag === "input") && newComment.trim()) {
        addComment();
        return;
      }
      if (runningRun) cancelRun();
      else if (showStuckBanner) retryStuck();
      else if (task?.status === "todo" && canRun) runNow();
      else if (task?.status === "in_review") applyStatusTransition({ from: "in_review", to: "done" });
      else if (task?.status === "done") applyStatusTransition({ from: "done", to: "todo" });
    },
    "e": () => { navigateHash(`#/tasks/${id}/edit`); },
    "E": () => { navigateHash(`#/tasks/${id}/edit`); },
  });

  if (!data) {
    return (
      <AppShell route="tasks" title="Tasks">
        <div class="page-wrap"><LoadingState caption="Loading task…" /></div>
      </AppShell>
    );
  }
  if (data.notFound) {
    return (
      <AppShell route="tasks" title="Tasks">
        <div class="page-wrap">
            <EmptyState
              title="Task not found"
              body="This task may have been deleted."
              cta={<Button variant="primary" onClick={() => { navigateHash("#/tasks"); }}>Back to tasks</Button>}
            />
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell route="tasks" title="Tasks" headerActions={headerActions}>
      <div class="task-detail">
        <div class="task-detail-main">
          <Breadcrumb items={[{ label: "Tasks", href: "#/tasks" }, { label: `#${String(task.id).slice(-6)}` }]} />

          <section class="task-hero">
            <div class="task-hero-top">
              <div class="task-hero-stack">
                <div class="task-hero-status-row">
                  {runningRun && <LivePulse size={10} />}
                  <StatusMenu status={task.status} onChoose={onStatusChoose} />
                  {hasLastRunError && (
                    <span class="chip chip-error">
                      <Icon name="alert-triangle" size={10} /> Error
                    </span>
                  )}
                  {showStuckBanner && (
                    <span class="chip chip-error">
                      <Icon name="alert-triangle" size={10} /> Stuck — reset
                    </span>
                  )}
                </div>
                <h1 class="task-hero-title title-display">{task.title}</h1>
              </div>
            </div>
            {task.instructions && (
              <div class="task-hero-instructions">
                <div class="all-caps task-hero-instructions-kicker">
                  <Icon name="terminal" size={10} /> Instructions to agent
                </div>
                <pre class="task-hero-instructions-body">{task.instructions}</pre>
              </div>
            )}
          </section>

          {showStuckBanner && (
            <Banner
              variant="warn"
              title="This task shows as running but no worker is active."
              detail={runError || undefined}
              actions={
                <>
                  <Button variant="secondary" size="sm" onClick={resetToTodo}>Reset</Button>
                  <Button variant="primary"  size="sm" onClick={retryStuck}>Retry</Button>
                </>
              }
              dismissible={false}
            />
          )}

          {runError && (
            <Banner variant="error" title="Run error" detail={runError} onDismiss={() => setRunError(null)} />
          )}

          {runningRun ? (
            <LiveRunPanel
              run={runningRun}
              events={[]}
              isStreaming
            />
          ) : latestRun ? (
            <Card variant="spacious" kicker={runningRun ? "Current run" : "Latest run"} title={formatDate(latestRun.started_at)}>
              <RunCard
                run={latestRun}
                expanded={expandedRunIds.has(latestRun.id)}
                onToggle={toggleRun}
                subscribe={latestRun.status === "running" && expandedRunIds.has(latestRun.id)}
                agentLabel={agentDisplayName(agents, latestRun.agent_name, latestRun.agent_name)}
              />
            </Card>
          ) : null}

          <Card kicker="Activity" title="Timeline">
            {visibleActivity.length === 0 ? (
              <div class="activity-empty">No activity yet.</div>
            ) : (
              <div class="activity-feed">
                {visibleActivity.map((item) => (
                  <div key={item.id} class="activity-item">
                    <div class="activity-item-head">
                      {item.type === "comment" && <><Icon name="message-circle" size={12} /><span>{item.author?.display_name || item.author?.id || "Someone"} commented</span></>}
                      {item.type === "run_started" && <><Icon name="play" size={12} /><span>Run started by {agentDisplayName(agents, item.agent, item.agent)}</span></>}
                      {item.type === "run_completed" && <><Icon name="check-circle" size={12} /><span>Run completed</span></>}
                      {item.type === "run_failed" && <><Icon name="alert-triangle" size={12} class="activity-item-icon-error" /><span>Run failed</span></>}
                      <span class="activity-item-time">{formatDate(item.at)}</span>
                    </div>
                    {item.type === "comment" && item.body && (
                      <div class="activity-item-body"><MarkdownContent content={item.body} maxHeight={200} /></div>
                    )}
                  </div>
                ))}
                {!showOlderActivity && activity.length > 12 && (
                  <Button variant="ghost" size="sm" onClick={() => setShowOlderActivity(true)}>
                    Show older ({activity.length - 12})
                  </Button>
                )}
              </div>
            )}

            <div class="activity-composer">
              <form onSubmit={addComment} class="activity-composer-form">
                <Textarea
                  rows={3}
                  autoGrow
                  placeholder="Add a comment…"
                  value={newComment}
                  onInput={(e) => setNewComment(e.target.value)}
                />
                <div class="activity-composer-actions">
                  <Button type="submit" variant="primary" disabled={!newComment.trim()}>Post</Button>
                </div>
              </form>
            </div>
          </Card>

          {runs.length > 1 && (
            <Card collapsible={{ summary: "Previous runs", count: runs.length - 1 }}>
              <div class="runs-expander-list">
                {runs.slice(1, 8).map((run) => (
                  <RunCard
                    key={run.id}
                    run={run}
                    expanded={expandedRunIds.has(run.id)}
                    onToggle={toggleRun}
                    subscribe={false}
                    agentLabel={agentDisplayName(agents, run.agent_name, run.agent_name)}
                  />
                ))}
              </div>
            </Card>
          )}

          {comments.length > 0 && (
            <Card collapsible={{ summary: "All comments", count: comments.length }}>
              <CommentList comments={comments} />
            </Card>
          )}
        </div>

        <aside class="task-detail-rail">
          <Card variant="spacious" title="Agents">
            <div class="rail-row">
              <span class="label">Executor</span>
              <span class="value">
                <span class="rail-row-avatar">
                  <AgentAvatar name={task.executor_agent} label={executorLabel} size={20} role="executor" />
                  <span>{executorLabel}</span>
                </span>
                <Select
                  value={task.executor_agent || ""}
                  onChange={(value) => updateAssignee("executor_agent", value)}
                  options={agentOptions}
                  placeholder="Assign executor"
                  ariaLabel="Reassign executor"
                  searchable
                />
              </span>
            </div>
            <div class="rail-row">
              <span class="label">Reviewer</span>
              <span class="value">
                <span class="rail-row-avatar">
                  <AgentAvatar name={task.reviewer_agent} label={reviewerLabel} size={20} role="reviewer" />
                  <span>{reviewerLabel || "Unassigned"}</span>
                </span>
                <Select
                  value={task.reviewer_agent || ""}
                  onChange={(value) => updateAssignee("reviewer_agent", value)}
                  options={agentOptions}
                  placeholder="Assign reviewer"
                  ariaLabel="Reassign reviewer"
                  searchable
                />
              </span>
            </div>
          </Card>

          <Card variant="spacious" title="Details">
            <KeyValueList entries={[
              ["Created", formatDate(task.created_at) || "—"],
              ["Updated", formatDate(task.updated_at) || "—"],
              ["Completed", formatDate(task.completed_at) || "—"],
              ["Schedule", task.source_schedule_id ? <a href={`#/schedules/${task.source_schedule_id}`}>Open schedule</a> : "—"],
              ["ID", task.id],
            ]} />
          </Card>

          {latestRun?.log && (
            <Card variant="spacious" title="Latest run">
              <div class="metric-grid">
                <Metric label="Duration" value={formatDuration(runDuration(latestRun)) || "—"} />
                <Metric label="Turns" value={latestRun.log.num_turns ?? "—"} />
                <Metric label="Tokens in" value={formatTokens(latestRun.log.input_tokens) || "—"} />
                <Metric label="Tokens out" value={formatTokens(latestRun.log.output_tokens) || "—"} />
                <div class="metric-span-2">
                  <Metric label="Cost" value={formatCost(latestRun.log.cost_usd) || "$0"} />
                </div>
              </div>
            </Card>
          )}

          {(task.tags || []).length > 0 && (
            <Card variant="spacious" title="Tags">
              <div class="task-tags">
                {(task.tags || []).map((t) => (
                  <Chip key={t} variant="tag">{t}</Chip>
                ))}
              </div>
            </Card>
          )}

          {((task.blocked_by || []).length > 0 || (task.blocks || []).length > 0) && (
            <Card variant="spacious" title="Dependencies">
              {(task.blocked_by || []).length > 0 && (
                <div class="dependency-group">
                  <div class="all-caps">Blocked by</div>
                  {(task.blocked_by || []).map((dependency) => (
                    <a key={dependency.id} class="blocked-link" href={`#/tasks/${dependency.id}`}>
                      <span class="truncate">{dependency.title}</span>
                      <StatusPill status={dependency.status} size="sm" />
                    </a>
                  ))}
                </div>
              )}
              {(task.blocks || []).length > 0 && (
                <div class={`dependency-group ${(task.blocked_by || []).length > 0 ? "dependency-group-spaced" : ""}`}>
                  <div class="all-caps">Blocks</div>
                  {(task.blocks || []).map((dependency) => (
                    <a key={dependency.id} class="blocked-link" href={`#/tasks/${dependency.id}`}>
                      <span class="truncate">{dependency.title}</span>
                      <StatusPill status={dependency.status} size="sm" />
                    </a>
                  ))}
                </div>
              )}
            </Card>
          )}

          <Card variant="spacious" title="Actions">
            <div class="task-actions-stack">
              <Button
                variant="secondary"
                iconLeft={<Icon name="copy" size={13} />}
                onClick={async () => {
                  try {
                    const copy = { title: `Copy of ${task.title}`, instructions: task.instructions, executor_agent: task.executor_agent, reviewer_agent: task.reviewer_agent, tags: task.tags };
                    const r = await api.createTask(copy);
                    pushToast("Task duplicated", { variant: "success" });
                    navigateHash(`#/tasks/${r.task.id}`);
                  } catch (err) { pushToast(`Duplicate failed: ${err.message}`, { variant: "error" }); }
                }}
              >Duplicate</Button>
              <ConfirmButton onConfirm={destroy} class="sm">Delete task</ConfirmButton>
            </div>
          </Card>
        </aside>
      </div>

      {/* Status-transition confirm modal */}
      <Modal
        open={!!statusModal}
        onClose={() => setStatusModal(null)}
        title="Confirm status change"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setStatusModal(null)}>Cancel</Button>
            <Button variant="primary" onClick={() => {
              const t = statusModal;
              setStatusModal(null);
              applyStatusTransition(t);
            }}>Confirm</Button>
          </>
        }
      >
        <p>{statusModal?.confirm || ""}</p>
      </Modal>

      {/* Delete task modal */}
      <Modal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="Delete task?"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={() => { setDeleteOpen(false); destroy(); }}>Delete</Button>
          </>
        }
      >
        <p>This permanently removes the task and its runs. This action cannot be undone.</p>
      </Modal>
    </AppShell>
  );
}
