// §6.3 TaskDetail — deep view of one task.
// Two-column layout. Hero with StatusMenu + primary action cluster. Stuck-task
// Banner (§5.2). LiveRunPanel while streaming. Activity feed. Previous runs.
// Rail: Agents, Context, Tags, Actions.
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
import { EventTimeline } from "../components/EventTimeline.jsx";
import { Card } from "../components/Card.jsx";
import { Chip } from "../components/primitives/Chip.jsx";
import { Banner } from "../components/Banner.jsx";
import { LoadingState } from "../components/LoadingState.jsx";
import { EmptyState } from "../components/EmptyState.jsx";
import { LiveRunPanel } from "../components/LiveRunPanel.jsx";
import { StatusMenu } from "../components/StatusMenu.jsx";
import { Modal } from "../components/Modal.jsx";
import { Textarea } from "../components/primitives/Textarea.jsx";
import { AgentPicker } from "../components/AgentPicker.jsx";
import { MarkdownContent } from "../components/Markdown.jsx";
import { navigateHash } from "../lib/navigation.js";
import { formatMode, runMetricItems } from "../lib/runFormatting.js";

function formatDate(v) { return v ? new Date(v).toLocaleString() : null; }

function formatActivityTime(value) {
  if (!value) return "";
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return "";
  const ms = Date.now() - timestamp;
  if (ms < 60_000) return "now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  if (ms < 86_400_000 * 7) return `${Math.floor(ms / 86_400_000)}d`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function RunMetric({ label, value }) {
  const key = String(label || "").toLowerCase().replace(/\s+/g, "-");
  return (
    <span class={`run-metric run-metric-${key}`}>
      <span class="run-metric-label">{label}</span>
      <span class="run-metric-value">{value}</span>
    </span>
  );
}

function commentAuthorLabel(item) {
  if (item.author?.display_name) return item.author.display_name;
  if (item.author?.id) return item.author.id;
  if (item.authorId) return item.authorId;
  if (item.authorType === "agent") return "Agent";
  if (item.authorType === "system") return "System";
  return "You";
}

function ContextRow({ icon, label, value, href }) {
  const content = href ? <a href={href}>{value}</a> : value;
  return (
    <div class="task-context-row">
      <span class="task-context-icon"><Icon name={icon} size={13} /></span>
      <span class="task-context-copy">
        <span class="task-context-label">{label}</span>
        <span class="task-context-value">{content}</span>
      </span>
    </div>
  );
}

function TaskContextCard({ task }) {
  const items = [
    task.updated_at ? { icon: "clock", label: "Updated", value: formatDate(task.updated_at) } : null,
    task.created_at ? { icon: "calendar", label: "Created", value: formatDate(task.created_at) } : null,
    task.completed_at ? { icon: "check-circle", label: "Completed", value: formatDate(task.completed_at) } : null,
    task.source_schedule_id
      ? {
          icon: "link",
          label: "Schedule",
          value: "Open schedule",
          href: `#/schedules/${task.source_schedule_id}`,
        }
      : null,
  ].filter(Boolean);

  if (items.length === 0) return null;

  return (
    <Card variant="spacious" title="Context" class="task-context-card">
      <div class="task-context-list">
        {items.map((item) => <ContextRow key={item.label} {...item} />)}
      </div>
    </Card>
  );
}

function ActivityRailDot({ item, agentLabel }) {
  const tone = item.type === "run" ? item.run?.status : item.authorType;
  const runAgent = item.run?.agent_name;
  const commentAgent = item.authorType === "agent" ? item.authorId || item.author?.id : null;
  if (item.type === "run" && runAgent) {
    return (
      <span class={`activity-feed-dot avatar run ${tone || ""}`}>
        <AgentAvatar name={runAgent} label={agentLabel || runAgent} size={20} compact />
      </span>
    );
  }
  if (commentAgent) {
    return (
      <span class={`activity-feed-dot avatar comment agent`}>
        <AgentAvatar name={commentAgent} label={commentAuthorLabel(item)} size={20} compact />
      </span>
    );
  }
  const icon = item.type === "run" ? "zap" : "message-circle";
  return (
    <span class={`activity-feed-dot ${item.type} ${tone || ""}`}>
      {item.authorType === "human" ? <span class="activity-feed-human-mark">@</span> : <Icon name={icon} size={12} />}
    </span>
  );
}

function AgentRailRow({ role, value, onChange, agents }) {
  const unassigned = !value;
  const roleLabel = role === "executor" ? "Executor" : "Reviewer";
  const caption = role === "executor"
    ? (unassigned ? "Required to run" : "Primary runner")
    : (unassigned ? "Optional" : "Review path");
  return (
    <div class={`rail-agent-row${unassigned ? " unassigned" : ""}`}>
      <div class="rail-agent-row-head">
        <div>
          <div class="rail-agent-row-kicker">{roleLabel}</div>
        </div>
        <span class="rail-agent-row-caption">{caption}</span>
      </div>
      <AgentPicker
        class="rail-agent-picker"
        value={value || null}
        onChange={onChange}
        agents={agents}
        placeholder={`Assign ${roleLabel.toLowerCase()}`}
        role={roleLabel}
        ariaLabel={`Reassign ${roleLabel.toLowerCase()}`}
        allowClear
      />
    </div>
  );
}

function RunCard({ run, expanded, highlighted, onToggle, agentLabel, subscribe }) {
  const { events, loading } = useRunStream(expanded || subscribe ? run?.id : null, { subscribe });
  const metrics = runMetricItems(run);
  const startedAt = formatDate(run.started_at);
  const shortStartedAt = formatActivityTime(run.started_at);
  const owner = agentLabel || run.agent_name;
  const title = owner ? `${owner} run` : "Agent run";
  const meta = [formatMode(run.mode), shortStartedAt].filter(Boolean).join(" · ");
  return (
    <details
      open={expanded}
      onToggle={(e) => onToggle?.(run.id, e.currentTarget.open)}
      class={`run-card${expanded ? " expanded" : ""}${highlighted ? " highlighted" : ""}`}
    >
      <summary class="run-card-summary">
        <div class="run-summary">
          <div class="run-summary-main">
            <div class="run-summary-status">
              <StatusPill status={run.status} size="sm" />
              <span class="run-summary-title">{title}</span>
            </div>
            {meta && <div class="run-summary-meta" title={startedAt || undefined}>{meta}</div>}
          </div>
          {metrics.length > 0 && (
            <div class="run-summary-metrics" aria-label="Run metrics">
              {metrics.map(([label, value]) => <RunMetric key={label} label={label} value={value} />)}
            </div>
          )}
          <div class="run-summary-side">
            <span>{expanded ? "Collapse" : "Details"}</span>
            <Icon name="chevron-down" size={14} class="run-summary-chevron" />
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
// One entry per run (not two) — sort by ended_at when present, else started_at.
function buildActivity({ comments = [], runs = [] }) {
  const items = [];
  for (const c of comments) {
    items.push({
      type: "comment",
      at: c.created_at || 0,
      author: c.author,
      authorType: c.author_type || c.author?.type || "human",
      authorId: c.author_id || c.author?.id || null,
      body: c.body || c.content || "",
      id: `c-${c.id || c.created_at}`,
    });
  }
  for (const r of runs) {
    items.push({
      type: "run",
      at: r.ended_at || r.started_at || 0,
      run: r,
      id: `r-${r.id}`,
    });
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
  const [commentSaving, setCommentSaving] = useState(false);
  const [showOlderActivity, setShowOlderActivity] = useState(false);
  const [instructionsExpanded, setInstructionsExpanded] = useState(false);

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

  useEffect(() => {
    if (!highlightedRunId) return;
    setExpandedRunIds((current) => {
      if (current.has(highlightedRunId)) return current;
      return new Set([...current, highlightedRunId]);
    });
  }, [highlightedRunId]);

  const task = data?.task;
  const runs = data?.runs || [];
  const comments = data?.comments || [];
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
  const displayActivity = useMemo(
    () => runningRun
      ? visibleActivity.filter((item) => !(item.type === "run" && item.run?.id === runningRun.id))
      : visibleActivity,
    [runningRun, visibleActivity],
  );

  const unresolvedBlockedBy = useMemo(
    () => (task?.blocked_by || []).filter((entry) => entry.status !== "done"),
    [task],
  );

  function toggleRun(runId, open) {
    setHighlightedRunId((current) => (open ? runId : current === runId ? null : current));
    setExpandedRunIds((s) => {
      const n = new Set(s);
      if (open) n.add(runId); else n.delete(runId);
      return n;
    });
  }

  async function addComment(e) {
    e?.preventDefault?.();
    if (!newComment.trim() || commentSaving) return;
    setCommentSaving(true);
    try {
      await api.addComment(id, newComment.trim());
      setNewComment("");
      reload();
    } catch (err) {
      pushToast(`Could not post comment: ${err.message}`, { variant: "error" });
    } finally {
      setCommentSaving(false);
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
          Cancel
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
          Run
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
            Request changes
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
              <div class={`task-hero-instructions${instructionsExpanded ? " expanded" : ""}${(task.instructions || "").length > 400 ? " clampable" : ""}`}>
                <div class="task-hero-instructions-head">
                  <div class="all-caps task-hero-instructions-kicker">
                    <Icon name="terminal" size={10} /> Instructions to agent
                  </div>
                  <button
                    type="button"
                    class="task-hero-instructions-copy"
                    aria-label="Copy instructions"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(task.instructions || "");
                        pushToast("Copied", { variant: "success" });
                      } catch {
                        pushToast("Copy failed", { variant: "error" });
                      }
                    }}
                  >
                    <Icon name="copy" size={12} />
                  </button>
                </div>
                <pre class="task-hero-instructions-body">{task.instructions}</pre>
                {(task.instructions || "").length > 400 && (
                  <button
                    type="button"
                    class="task-hero-instructions-toggle"
                    onClick={() => setInstructionsExpanded((v) => !v)}
                  >
                    {instructionsExpanded ? "Show less" : "Show full"}
                  </button>
                )}
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
              isStreaming
              agentLabel={agentDisplayName(agents, runningRun.agent_name, runningRun.agent_name)}
            />
          ) : null}

          <Card
            title="Activity"
            class="activity-card"
          >
            <div class="activity-composer">
              <form onSubmit={addComment} class="activity-composer-form">
                <Textarea
                  rows={1}
                  autoGrow
                  class="activity-composer-input"
                  placeholder="Add a comment or instruction…"
                  value={newComment}
                  onInput={(e) => setNewComment(e.target.value)}
                />
                <div class="activity-composer-actions">
                  <span class="activity-composer-shortcut">Cmd Enter</span>
                  <Button type="submit" variant="primary" disabled={!newComment.trim() || commentSaving}>
                    {commentSaving ? "Posting…" : "Post"}
                  </Button>
                </div>
              </form>
            </div>

            {displayActivity.length > 0 ? (
              <div class="activity-feed">
                {displayActivity.map((item) => {
                  if (item.type === "run") {
                    const run = item.run;
                    return (
                      <div key={item.id} class="activity-feed-entry run">
                        <div class="activity-feed-rail">
                          <ActivityRailDot item={item} agentLabel={agentDisplayName(agents, run.agent_name, run.agent_name)} />
                        </div>
                        <div class="activity-feed-content">
                          <RunCard
                            run={run}
                            expanded={expandedRunIds.has(run.id)}
                            highlighted={highlightedRunId === run.id}
                            onToggle={toggleRun}
                            subscribe={run.status === "running"}
                            agentLabel={agentDisplayName(agents, run.agent_name, run.agent_name)}
                          />
                        </div>
                      </div>
                    );
                  }
                  return (
                    <div key={item.id} class={`activity-feed-entry comment ${item.authorType || "human"}`}>
                      <div class="activity-feed-rail"><ActivityRailDot item={item} /></div>
                      <div class="activity-feed-content activity-item">
                        <div class="activity-item-head">
                          <span class={`activity-author-badge ${item.authorType || "human"}`}>{commentAuthorLabel(item)}</span>
                          <span class="activity-item-time" title={formatDate(item.at) || undefined}>{formatActivityTime(item.at)}</span>
                        </div>
                        {item.body && (
                          <div class="activity-item-body"><MarkdownContent content={item.body} maxHeight={200} /></div>
                        )}
                      </div>
                    </div>
                  );
                })}
                {!showOlderActivity && activity.length > 12 && (
                  <Button variant="ghost" size="sm" onClick={() => setShowOlderActivity(true)}>
                    Show older ({activity.length - 12})
                  </Button>
                )}
              </div>
            ) : (
              <div class="activity-empty">{runningRun ? "No comments or completed runs yet." : "No activity yet."}</div>
            )}
          </Card>
        </div>

        <aside class="task-detail-rail">
          <Card title="Agents" class="rail-agents-card">
            <div class="rail-agents-stack">
              <AgentRailRow
                role="executor"
                value={task.executor_agent || ""}
                onChange={(value) => updateAssignee("executor_agent", value)}
                agents={agents}
              />
              <AgentRailRow
                role="reviewer"
                value={task.reviewer_agent || ""}
                onChange={(value) => updateAssignee("reviewer_agent", value)}
                agents={agents}
              />
            </div>
          </Card>

          <TaskContextCard task={task} />

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

          <Card collapsible={{ summary: "More actions", count: 3 }}>
            <div class="task-actions-stack">
              <Button
                variant="secondary"
                iconLeft={<Icon name="database" size={13} />}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(task.id);
                    pushToast("Task ID copied", { variant: "success" });
                  } catch {
                    pushToast("Copy failed", { variant: "error" });
                  }
                }}
              >
                Copy task ID
              </Button>
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
              <Button
                variant="destructive"
                iconLeft={<Icon name="trash" size={13} />}
                onClick={() => setDeleteOpen(true)}
              >
                Delete task
              </Button>
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
