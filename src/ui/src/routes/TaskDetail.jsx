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
import { agentDisplayName, taskDisplayKey, taskRouteId } from "../lib/display.js";
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
import { Input } from "../components/primitives/Input.jsx";
import { Select } from "../components/primitives/Select.jsx";
import { Checkbox } from "../components/primitives/Checkbox.jsx";
import { AgentPicker } from "../components/AgentPicker.jsx";
import { MarkdownContent } from "../components/Markdown.jsx";
import { StructuredContent } from "../components/StructuredContent.jsx";
import { navigateHash } from "../lib/navigation.js";
import { formatRunSummaryTitle, runMetricItems, runResultPreview } from "../lib/runFormatting.js";
import { collapseDuplicateParagraphs, normalizeCommentText, shouldHideComment } from "../lib/commentFormatting.js";

function formatDate(v) { return v ? new Date(v).toLocaleString() : null; }

function formatRunPolicy(value) {
  return value === "auto_plan_execute" ? "Auto plan + work" : "Manual";
}

const DEFAULT_RUN_POLICY = "auto_plan_execute";

const AUTOMATION_TRIGGER_OPTIONS = [
  { value: "once", label: "Once" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
];

const WEEKDAY_OPTIONS = [
  { value: "0", label: "Sunday" },
  { value: "1", label: "Monday" },
  { value: "2", label: "Tuesday" },
  { value: "3", label: "Wednesday" },
  { value: "4", label: "Thursday" },
  { value: "5", label: "Friday" },
  { value: "6", label: "Saturday" },
];

function pad2(value) {
  return String(value).padStart(2, "0");
}

function defaultRunAt() {
  const hourFromNow = Date.now() + 3_600_000;
  const date = new Date(hourFromNow);
  date.setSeconds(0, 0);
  return date.getTime();
}

function emptyAutomationDraft() {
  return {
    enabled: true,
    trigger: { type: "daily", hour: 9, minute: 0 },
  };
}

function normalizeAutomationTrigger(trigger = {}) {
  const type = trigger?.type || "daily";
  if (type === "once") return { type, run_at: Number(trigger.run_at) || defaultRunAt() };
  const base = {
    type,
    hour: Number.isFinite(Number(trigger.hour)) ? Number(trigger.hour) : 9,
    minute: Number.isFinite(Number(trigger.minute)) ? Number(trigger.minute) : 0,
  };
  if (type === "weekly") base.weekdays = Array.isArray(trigger.weekdays) && trigger.weekdays.length ? trigger.weekdays : [1];
  if (type === "monthly") base.day_of_month = Number(trigger.day_of_month) || 1;
  return base;
}

function automationDraftFrom(automation) {
  return {
    enabled: automation.enabled !== false,
    trigger: normalizeAutomationTrigger(automation.trigger),
  };
}

function timeValue(trigger) {
  return `${pad2(trigger?.hour ?? 9)}:${pad2(trigger?.minute ?? 0)}`;
}

function updateTriggerTime(trigger, value) {
  const [hour = "09", minute = "00"] = String(value || "").split(":");
  return { ...trigger, hour: Number(hour) || 0, minute: Number(minute) || 0 };
}

function dateTimeLocalValue(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms)) return "";
  const date = new Date(ms);
  return [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
  ].join("-") + `T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function parseDateTimeLocal(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : defaultRunAt();
}

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
    task.automation_summary?.next_fire_at ? { icon: "clock", label: "Next scheduled run", value: formatDate(task.automation_summary.next_fire_at) } : null,
    { icon: "zap", label: "Run mode", value: formatRunPolicy(task.run_policy) },
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
  const tone = item.type === "run" ? (item.run?.process_status || item.run?.status) : item.authorType;
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

// §6.3 supplemental — surfaces workflow context that the backend records but
// the original UI did not render: parent breadcrumb (for delegated children),
// stage_reason ("why" copy from the agent), pending_actions (when paused),
// and blocking_issues (when blocked).
function TaskWorkflowMeta({ task }) {
  if (!task) return null;
  const showParent = task.parent && task.parent.id && task.parent.id !== task.id;
  const stageReason = task.stage_reason;
  const pendingActions = Array.isArray(task.pending_actions) ? task.pending_actions : [];
  const blockingIssues = Array.isArray(task.blocking_issues) ? task.blocking_issues : [];
  const showPendingActions = task.stage === "awaiting_user" && pendingActions.length > 0;
  const showStageReason = stageReason && task.stage !== "execute" && task.stage !== "done";
  if (!showParent && !showStageReason && !showPendingActions && blockingIssues.length === 0) {
    return null;
  }
  return (
    <section class="task-workflow-meta">
      {showParent && (
        <a class="task-workflow-parent" href={`#/tasks/${taskRouteId(task.parent)}`}>
          <Icon name="corner-up-left" size={12} />
          <span class="task-workflow-parent-label">Parent</span>
          <span class="truncate">{task.parent.title}</span>
        </a>
      )}
      {showStageReason && (
        <div class="task-workflow-stage-reason">
          <Icon name="info" size={12} />
          <span>{stageReason}</span>
        </div>
      )}
      {showPendingActions && (
        <Card title="Human actions needed" class="task-workflow-pending">
          <ul class="task-workflow-list">
            {pendingActions.map((action, idx) => <li key={idx}>{action}</li>)}
          </ul>
        </Card>
      )}
      {blockingIssues.length > 0 && (
        <Card title="Blocking issues" class="task-workflow-blocking">
          <ul class="task-workflow-list">
            {blockingIssues.map((issue, idx) => <li key={idx}>{issue}</li>)}
          </ul>
        </Card>
      )}
    </section>
  );
}

function TaskPlanCard({
  task,
  draft,
  editing,
  saving,
  onDraft,
  onEdit,
  onCancel,
  onSave,
}) {
  const planBody = task?.plan_body || "";
  const displayPlanBody = collapseDuplicateParagraphs(planBody);
  const hasPlan = planBody.trim().length > 0;
  const meta = [
    task?.plan_updated_at ? `Updated ${formatDate(task.plan_updated_at)}` : null,
    task?.plan_updated_by ? `by ${task.plan_updated_by}` : null,
    task?.plan_source_run_id ? `from run ${String(task.plan_source_run_id).slice(-6)}` : null,
  ].filter(Boolean).join(" ");

  return (
    <Card
      title="Plan"
      class="task-plan-card"
      headerRight={
        editing ? (
          <>
            <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>Cancel</Button>
            <Button variant="primary" size="sm" onClick={onSave} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </>
        ) : (
          <Button variant="secondary" size="sm" iconLeft={<Icon name={hasPlan ? "edit-3" : "plus"} size={13} />} onClick={onEdit}>
            {hasPlan ? "Edit" : "Write"}
          </Button>
        )
      }
    >
      {meta && <div class="task-plan-meta">{meta}</div>}
      {editing ? (
        <Textarea
          rows={8}
          autoGrow
          class="task-plan-editor"
          placeholder="Write the task plan…"
          value={draft}
          onInput={(event) => onDraft(event.currentTarget.value)}
        />
      ) : hasPlan ? (
        <div class="task-plan-body">
          <MarkdownContent content={displayPlanBody} maxHeight={360} />
        </div>
      ) : (
        <div class="task-plan-empty">No plan yet. Run plan or write one.</div>
      )}
    </Card>
  );
}

function TaskSubtasksCard({
  task,
  agents,
  title,
  owner,
  required,
  saving,
  onTitle,
  onOwner,
  onRequired,
  onCreate,
}) {
  const children = Array.isArray(task?.children) ? task.children : [];
  return (
    <Card title={`Subtasks (${children.length})`} class="task-subtasks-card">
      {children.length > 0 ? (
        <ul class="task-subtasks-list">
          {children.map((child) => (
            <li key={child.id}>
              <a href={`#/tasks/${taskRouteId(child)}`} class="task-subtask-link">
                <span class="truncate">{child.title}</span>
                <span class="task-subtask-meta">
                  <Chip variant={child.required === false ? "muted" : "tag"} size="sm">
                    {child.required === false ? "optional" : "required"}
                  </Chip>
                  <StatusPill status={child.stage || "plan"} size="sm" />
                </span>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <div class="task-subtasks-empty">No subtasks yet.</div>
      )}
      <form class="task-subtasks-add" onSubmit={onCreate}>
        <Input
          class="task-subtasks-title"
          placeholder="Subtask title"
          value={title}
          onInput={(event) => onTitle(event.currentTarget.value)}
          disabled={saving}
        />
        <AgentPicker
          class="task-subtasks-owner"
          value={owner || ""}
          onChange={onOwner}
          agents={agents}
          placeholder="Owner"
          role="Owner"
          ariaLabel="Subtask owner"
          allowClear
        />
        <Checkbox
          class="task-subtasks-required"
          checked={required}
          onChange={onRequired}
          label="Required"
          disabled={saving}
        />
        <Button type="submit" variant="primary" disabled={saving || !title.trim()}>
          {saving ? "Adding…" : "Add"}
        </Button>
      </form>
    </Card>
  );
}

function automationOutcomeMeta(automation) {
  const latest = automation.recent_triggers?.[0] || null;
  if (!automation.enabled) return { label: "Paused", className: "chip-muted", icon: "minus-circle" };
  if (latest?.outcome === "skipped") return { label: "Skipped", className: "chip-warn", icon: "alert-circle" };
  if (latest?.outcome === "failed") return { label: "Failed", className: "chip-error", icon: "alert-triangle" };
  return { label: "Enabled", className: "chip-trigger", icon: "clock" };
}

function TaskAutomationsCard({ taskId, automations, loading, onChanged }) {
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState(emptyAutomationDraft);
  const [saving, setSaving] = useState(false);

  function startNew() {
    setEditingId("new");
    setDraft(emptyAutomationDraft());
  }

  function startEdit(automation) {
    setEditingId(automation.id);
    setDraft(automationDraftFrom(automation));
  }

  function cancelEdit() {
    setEditingId(null);
    setDraft(emptyAutomationDraft());
  }

  function patchDraft(patch) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  function patchTrigger(patch) {
    setDraft((current) => ({
      ...current,
      trigger: normalizeAutomationTrigger({ ...current.trigger, ...patch }),
    }));
  }

  async function saveAutomation(event) {
    event?.preventDefault?.();
    setSaving(true);
    try {
      const payload = {
        enabled: !!draft.enabled,
        trigger: normalizeAutomationTrigger(draft.trigger),
      };
      if (editingId === "new") {
        await api.createTaskAutomation(taskId, payload);
        pushToast("Schedule created", { variant: "success" });
      } else {
        await api.patchTaskAutomation(taskId, editingId, payload);
        pushToast("Schedule saved", { variant: "success" });
      }
      cancelEdit();
      onChanged?.();
    } catch (error) {
      pushToast(`Schedule save failed: ${error.message}`, { variant: "error" });
    } finally {
      setSaving(false);
    }
  }

  async function deleteAutomation(automation) {
    try {
      await api.deleteTaskAutomation(taskId, automation.id);
      pushToast("Schedule deleted", { variant: "success" });
      if (editingId === automation.id) cancelEdit();
      onChanged?.();
    } catch (error) {
      pushToast(`Delete failed: ${error.message}`, { variant: "error" });
    }
  }

  async function runAutomation(automation) {
    try {
      const result = await api.runTaskAutomation(taskId, automation.id);
      if (result?.skipped) pushToast(`Schedule skipped: ${result.reason}`, { variant: "info" });
      else pushToast("Scheduled run started", { variant: "success" });
      onChanged?.();
    } catch (error) {
      pushToast(`Run failed: ${error.message}`, { variant: "error" });
    }
  }

  const list = automations || [];
  return (
    <Card
      title={`Automations (${list.length})`}
      class="task-automations-card"
      headerRight={
        <Button size="sm" variant="secondary" iconLeft={<Icon name="plus" size={12} />} onClick={startNew}>
          Add
        </Button>
      }
    >
      {editingId && (
        <form class="task-automation-form" onSubmit={saveAutomation}>
          <Select
            variant="native"
            value={draft.trigger.type}
            onChange={(value) => patchDraft({ trigger: normalizeAutomationTrigger({ ...draft.trigger, type: value }) })}
            options={AUTOMATION_TRIGGER_OPTIONS}
            ariaLabel="Schedule trigger type"
            disabled={saving}
          />
          {draft.trigger.type === "once" ? (
            <Input
              type="datetime-local"
              aria-label="Run at"
              value={dateTimeLocalValue(draft.trigger.run_at)}
              onInput={(event) => patchTrigger({ run_at: parseDateTimeLocal(event.currentTarget.value) })}
              disabled={saving}
            />
          ) : (
            <Input
              type="time"
              aria-label="Schedule time"
              value={timeValue(draft.trigger)}
              onInput={(event) => patchTrigger(updateTriggerTime(draft.trigger, event.currentTarget.value))}
              disabled={saving}
            />
          )}
          {draft.trigger.type === "weekly" && (
            <Select
              variant="native"
              value={String(draft.trigger.weekdays?.[0] ?? 1)}
              onChange={(value) => patchTrigger({ weekdays: [Number(value)] })}
              options={WEEKDAY_OPTIONS}
              ariaLabel="Schedule weekday"
              disabled={saving}
            />
          )}
          {draft.trigger.type === "monthly" && (
            <Input
              type="number"
              aria-label="Day of month"
              min="1"
              max="31"
              value={String(draft.trigger.day_of_month || 1)}
              onInput={(event) => patchTrigger({ day_of_month: Number(event.currentTarget.value) || 1 })}
              disabled={saving}
            />
          )}
          <Checkbox
            checked={!!draft.enabled}
            onChange={(value) => patchDraft({ enabled: value })}
            label="Enabled"
            disabled={saving}
          />
          <div class="task-automation-form-actions">
            <Button type="button" size="sm" variant="ghost" onClick={cancelEdit} disabled={saving}>Cancel</Button>
            <Button type="submit" size="sm" variant="primary" loading={saving}>{editingId === "new" ? "Create" : "Save"}</Button>
          </div>
        </form>
      )}
      {loading ? (
        <div class="field-hint">Loading schedules...</div>
      ) : list.length === 0 ? (
        <div class="task-automations-empty">No schedules yet.</div>
      ) : (
        <div class="task-automation-list">
          {list.map((automation) => {
            const meta = automationOutcomeMeta(automation);
            const latest = automation.recent_triggers?.[0] || null;
            return (
              <div key={automation.id} class="task-automation-row">
                <div class="task-automation-main">
                  <span class={`chip ${meta.className}`} title={latest?.reason || undefined}>
                    <Icon name={meta.icon} size={10} /> {meta.label}
                  </span>
                  <span class="task-automation-trigger">{automation.trigger_summary}</span>
                  <span class="soft-meta">
                    {automation.next_fire_at ? `next ${formatDate(automation.next_fire_at)}` : "no upcoming run"}
                  </span>
                  {latest?.reason && <span class="task-automation-reason">{latest.reason}</span>}
                </div>
                <div class="task-automation-actions">
                  <Button size="sm" variant="ghost" iconLeft={<Icon name="play" size={12} />} onClick={() => runAutomation(automation)}>
                    Run
                  </Button>
                  <Button size="sm" variant="ghost" iconLeft={<Icon name="settings" size={12} />} onClick={() => startEdit(automation)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" iconLeft={<Icon name="trash" size={12} />} onClick={() => deleteAutomation(automation)}>
                    Delete
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function AgentRailRow({ role, value, onChange, agents, caption: captionOverride }) {
  const unassigned = !value;
  const roleLabel = role === "owner"
    ? "Owner"
    : "Reviewer";
  const caption = captionOverride || (role === "owner"
    ? (unassigned ? "Required to run plan or work" : "Plans, delegates, and runs work")
    : (unassigned ? "Optional" : "Runs review"));
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

function RunCard({ run, expanded, highlighted, onToggle, subscribe }) {
  const { events, loading } = useRunStream(expanded || subscribe ? run?.id : null, { subscribe });
  const metrics = runMetricItems(run);
  const resultPreview = runResultPreview(run);
  const startedAt = formatDate(run.started_at);
  const shortStartedAt = formatActivityTime(run.started_at);
  const title = formatRunSummaryTitle(run, shortStartedAt);
  const processStatus = run.process_status || run.status;
  const warningLabel = processStatus === "succeeded" && Number(run.log?.num_turns) === 0
    ? "No final text"
    : null;
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
              <StatusPill status={processStatus} size="sm" />
              {run.automation_trigger_type && (
                <span class="chip chip-trigger">
                  <Icon name="clock" size={10} /> Scheduled
                </span>
              )}
              <span class="run-summary-title" title={startedAt || undefined}>{title}</span>
              {warningLabel && <span class="run-warning-badge">{warningLabel}</span>}
            </div>
            {resultPreview.hasResult && (
              <div class="run-summary-result">
                <div class="run-summary-result-head">
                  {resultPreview.decision && (
                    <span class={`run-result-decision ${resultPreview.tone || ""}`.trim()}>
                      {resultPreview.decision}
                    </span>
                  )}
                  {resultPreview.summary && <span class="run-result-summary">{resultPreview.summary}</span>}
                </div>
                {resultPreview.details && <div class="run-result-details">{resultPreview.details}</div>}
              </div>
            )}
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
      {run.raw_output_path && (
        <div class="run-card-actions">
          <a href={`/api/runs/${run.id}/raw-log`} target="_blank" rel="noreferrer">
            Raw log
          </a>
        </div>
      )}
      <div class="run-card-events">
        {loading ? (
          <div class="run-card-events-loading">Loading events…</div>
        ) : (
          <EventTimeline events={events} streaming={processStatus === "running"} />
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
    if (shouldHideComment(c)) continue;
    items.push({
      type: "comment",
      at: c.created_at || 0,
      author: c.author,
      authorType: c.author_type || c.author?.type || "human",
      authorId: c.author_id || c.author?.id || null,
      body: normalizeCommentText(c.body || c.content || ""),
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
  const [commentRerun, setCommentRerun] = useState(true);
  const [highlightedRunId, setHighlightedRunId] = useState(runParam);
  const [expandedRunIds, setExpandedRunIds] = useState(() => new Set());
  const [runError, setRunError] = useState(null);
  const [statusModal, setStatusModal] = useState(null); // pending transition
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [commentSaving, setCommentSaving] = useState(false);
  const [showOlderActivity, setShowOlderActivity] = useState(false);
  const [instructionsExpanded, setInstructionsExpanded] = useState(false);
  const [planDraft, setPlanDraft] = useState("");
  const [planEditing, setPlanEditing] = useState(false);
  const [planSaving, setPlanSaving] = useState(false);
  const [subtaskTitle, setSubtaskTitle] = useState("");
  const [subtaskOwner, setSubtaskOwner] = useState("");
  const [subtaskRequired, setSubtaskRequired] = useState(true);
  const [subtaskSaving, setSubtaskSaving] = useState(false);
  const [taskAutomations, setTaskAutomations] = useState(null);
  const [automationsLoading, setAutomationsLoading] = useState(false);

  const reload = useCallback(() => {
    api.getTask(id).then(setData).catch(() => setData({ notFound: true }));
  }, [id]);
  const reloadAutomations = useCallback(() => {
    setAutomationsLoading(true);
    api.listTaskAutomations(id)
      .then((response) => setTaskAutomations(response.automations || []))
      .catch(() => setTaskAutomations([]))
      .finally(() => setAutomationsLoading(false));
  }, [id]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { reloadAutomations(); }, [reloadAutomations]);
  useEffect(() => {
    api.listAgents().then((r) => setAgents(r.agents || [])).catch(() => setAgents([]));
  }, []);
  useEffect(() => {
    setHighlightedRunId(runParam || null);
    setExpandedRunIds(new Set());
    setRunError(null);
    setPlanEditing(false);
    setPlanDraft("");
    setSubtaskTitle("");
    setTaskAutomations(null);
    setCommentRerun(true);
  }, [id, runParam]);

  useEffect(() => {
    const currentTask = data?.task;
    if (!currentTask || planEditing) return;
    setPlanDraft(currentTask.plan_body || "");
  }, [data?.task?.id, data?.task?.plan_body, planEditing]);

  useEffect(() => {
    const currentTask = data?.task;
    if (!currentTask) return;
    setSubtaskOwner(currentTask.owner_agent || "");
    setSubtaskRequired(true);
  }, [data?.task?.id, data?.task?.owner_agent]);

  useSSE("global", (evt) => {
    const currentTask = data?.task;
    const matchesCurrentTask = (value) => Boolean(value)
      && (value === id || value === currentTask?.id || value === currentTask?.task_key);
    const taskChanged = matchesCurrentTask(evt.id) || matchesCurrentTask(evt.taskKey);
    const runChanged = (matchesCurrentTask(evt.taskId) || matchesCurrentTask(evt.taskKey))
      && (evt.type === "run_started" || evt.type === "run_ended");
    const automationChanged = (matchesCurrentTask(evt.taskId) || matchesCurrentTask(evt.taskKey))
      && String(evt.type || "").startsWith("automation_");
    if (taskChanged || runChanged || automationChanged) reload();
    if (automationChanged || runChanged) reloadAutomations();
    if (evt.type === "run_started" && (matchesCurrentTask(evt.taskId) || matchesCurrentTask(evt.taskKey))) {
      setHighlightedRunId(evt.runId);
    }
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
  const operationTaskId = task?.id || id;
  const currentTaskRouteId = task ? taskRouteId(task) : encodeURIComponent(id);
  const taskKeyLabel = taskDisplayKey(task || id);
  const runs = data?.runs || [];
  const comments = data?.comments || [];
  const stage = task?.stage || "plan";
  const automationSummary = task?.automation_summary || {};
  const hasTaskSchedules = Number(automationSummary.count || 0) > 0;
  const hasEnabledSchedule = Number(automationSummary.enabled_count || 0) > 0;
  const runningRun = runs.find((r) => (r.process_status || r.status) === "running") || null;
  const displayedStage = runningRun ? "running" : stage;
  const lastFinishedRun = runs.find((r) => (r.process_status || r.status) && (r.process_status || r.status) !== "running") || null;
  const lastRunState = lastFinishedRun?.process_status || lastFinishedRun?.status;
  const hasLastRunError = lastRunState === "failed" || lastRunState === "error" || lastRunState === "abandoned";
  // §5.2 stuck-task: requires backend is_locked field. Until it ships, we do
  // NOT render the banner (prevents false positives).
  const showStuckBanner =
    task?.running_run_id && task?.is_locked === false;

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
    () => (task?.blocked_by || []).filter((entry) => (entry.stage || "plan") !== "done"),
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
      const shouldRerun = commentRerun && !runningRun;
      const result = await api.addComment(operationTaskId, newComment.trim(), { rerun: shouldRerun });
      setNewComment("");
      setCommentRerun(true);
      if (result?.rerun?.started) {
        if (result.rerun.runId) {
          setHighlightedRunId(result.rerun.runId);
          setExpandedRunIds((s) => new Set([...s, result.rerun.runId]));
        }
        pushToast("Comment posted and run started", { variant: "success" });
      } else if (result?.rerun?.error) {
        pushToast(`Comment posted; rerun did not start: ${result.rerun.error.message}`, { variant: "error" });
      }
      reload();
    } catch (err) {
      pushToast(`Could not post comment: ${err.message}`, { variant: "error" });
    } finally {
      setCommentSaving(false);
    }
  }

  async function savePlan() {
    setPlanSaving(true);
    try {
      await api.patchTask(operationTaskId, { plan_body: planDraft });
      setPlanEditing(false);
      reload();
      pushToast("Plan saved", { variant: "success" });
    } catch (err) {
      pushToast(`Plan save failed: ${err.message}`, { variant: "error" });
    } finally {
      setPlanSaving(false);
    }
  }

  function cancelPlanEdit() {
    setPlanDraft(task?.plan_body || "");
    setPlanEditing(false);
  }

  async function createManualSubtask(event) {
    event?.preventDefault?.();
    const title = subtaskTitle.trim();
    if (!title || subtaskSaving) return;
    setSubtaskSaving(true);
    try {
      await api.createSubtask(operationTaskId, {
        title,
        owner_agent: subtaskOwner || null,
        required: subtaskRequired,
      });
      setSubtaskTitle("");
      setSubtaskRequired(true);
      reload();
      pushToast("Subtask added", { variant: "success" });
    } catch (err) {
      pushToast(`Subtask failed: ${err.message}`, { variant: "error" });
    } finally {
      setSubtaskSaving(false);
    }
  }

  async function destroy() {
    try {
      await api.deleteTask(operationTaskId);
      pushToast("Task deleted", { variant: "success" });
      navigateHash("#/tasks");
    } catch (err) {
      pushToast(`Delete failed: ${err.message}`, { variant: "error" });
    }
  }

  async function runNow() {
    setRunError(null);
    try {
      const r = await api.runTask(operationTaskId);
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
    try { await api.cancelTask(operationTaskId); pushToast("Run cancelled", { variant: "info" }); }
    catch (err) { setRunError(err.message); pushToast(`Cancel failed: ${err.message}`, { variant: "error" }); }
  }

  async function resetToExecute() {
    try {
      await api.patchTask(operationTaskId, { stage: "execute" });
      reload();
      pushToast("Reset to execute", { variant: "success" });
    } catch (err) {
      pushToast(`Reset failed: ${err.message}`, { variant: "error" });
    }
  }

  async function retryStuck() {
    try {
      await api.patchTask(operationTaskId, { stage: "execute" });
      const r = await api.runTask(operationTaskId);
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
      if ((t.to === "execute" || t.to === "plan") && runningRun) {
        await runNow();
        return;
      }
      await api.patchTask(operationTaskId, { stage: t.to });
      reload();
      pushToast(`Stage → ${t.to}`, { variant: "success" });
    } catch (err) {
      pushToast(`Stage change failed: ${err.message}`, { variant: "error" });
    }
  }

  function onStatusChoose(t) {
    if (t.confirm) setStatusModal(t);
    else applyStatusTransition(t);
  }

  async function updateAssignee(role, value) {
    try {
      await api.patchTask(operationTaskId, { [role]: value || null });
      pushToast("Assignment updated", { variant: "success" });
      reload();
    } catch (error) {
      pushToast(`Assignment failed: ${error.message}`, { variant: "error" });
    }
  }

  // §6.3 primary action cluster per stage
  const runnableStages = ["plan", "execute", "review"];
  const selectedAgent = stage === "review" ? task?.reviewer_agent : task?.owner_agent;
  const runCopy = {
    plan: {
      label: "Run plan",
      title: "Owner plans the task, may delegate subtasks, then moves it to Execute.",
      missing: "Assign an owner to run plan",
    },
    execute: {
      label: "Run work",
      title: "Owner performs the work. It moves to Review when a reviewer is assigned, otherwise Done.",
      missing: "Assign an owner to run work",
    },
    review: {
      label: "Run review",
      title: "Reviewer checks the latest work and approves to Done or rejects back to Execute.",
      missing: "Assign a reviewer to run review",
    },
  }[stage];
  const canRun = selectedAgent && runnableStages.includes(stage) && unresolvedBlockedBy.length === 0;
  const runDisabledReason = !selectedAgent
    ? (runCopy?.missing || "No run action in this stage")
    : unresolvedBlockedBy.length > 0
      ? `Blocked by ${unresolvedBlockedBy.map((entry) => entry.title).join(", ")}`
      : undefined;
  function renderPrimaryAction() {
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
    if (stage === "review" && !runningRun) {
      return (
        <>
          <Button
            variant="primary"
            iconLeft={<Icon name="play" size={13} />}
            onClick={runNow}
            disabled={!canRun}
            title={runDisabledReason || runCopy?.title}
          >
            {runCopy.label}
          </Button>
          <Button variant="secondary" onClick={() => applyStatusTransition({ from: "review", to: "done" })}>
            Approve
          </Button>
          <Button variant="secondary" onClick={() => applyStatusTransition({ from: "review", to: "execute" })}>
            Request changes
          </Button>
        </>
      );
    }
    if (runnableStages.includes(stage)) {
      return (
        <Button
          variant="primary"
          iconLeft={<Icon name="play" size={13} />}
          onClick={runNow}
          disabled={!canRun}
          title={runDisabledReason || runCopy?.title}
        >
          {runCopy?.label || "Run"}
        </Button>
      );
    }
    if (stage === "awaiting_children") {
      return (
        <Button
          variant="secondary"
          iconLeft={<Icon name="play" size={13} />}
          onClick={() => applyStatusTransition({ from: "awaiting_children", to: "execute" })}
          title="Move back to Execute without waiting for every delegated subtask."
        >
          Resume work
        </Button>
      );
    }
    if (stage === "awaiting_user") {
      return (
        <Button
          variant="secondary"
          iconLeft={<Icon name="play" size={13} />}
          onClick={() => applyStatusTransition({ from: "awaiting_user", to: "execute" })}
          title="Move back to Execute after the requested input is handled."
        >
          Resume work
        </Button>
      );
    }
    if (stage === "blocked") {
      return (
        <Button
          variant="secondary"
          iconLeft={<Icon name="refresh-cw" size={13} />}
          onClick={() => applyStatusTransition({ from: "blocked", to: "execute" })}
          title="Clear the blocked state and move back to Execute."
        >
          Retry work
        </Button>
      );
    }
    if (stage === "done") {
      return (
        <Button variant="secondary" onClick={() => applyStatusTransition({ from: "done", to: "execute" })}>
          Reopen
        </Button>
      );
    }
    return null;
  }

  const headerActions = task && (
    <>
      {renderPrimaryAction()}
      <Button variant="ghost" iconLeft={<Icon name="settings" size={13} />} onClick={() => { navigateHash(`#/tasks/${currentTaskRouteId}/edit`); }}>
        Edit
      </Button>
    </>
  );
  const mobileActionDock = task && (
    <>
      {renderPrimaryAction()}
      <Button variant="secondary" iconLeft={<Icon name="settings" size={13} />} onClick={() => { navigateHash(`#/tasks/${currentTaskRouteId}/edit`); }}>
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
      else if (canRun) runNow();
      else if (stage === "awaiting_children" || stage === "awaiting_user" || stage === "blocked") {
        applyStatusTransition({ from: stage, to: "execute" });
      }
      else if (stage === "done") applyStatusTransition({ from: "done", to: "execute" });
    },
    "e": () => { navigateHash(`#/tasks/${currentTaskRouteId}/edit`); },
    "E": () => { navigateHash(`#/tasks/${currentTaskRouteId}/edit`); },
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
    <AppShell route="tasks" title="Tasks" headerActions={headerActions} mobileActionDock={mobileActionDock}>
      <div class="task-detail">
        <div class="task-detail-main">
          <Breadcrumb items={[{ label: "Tasks", href: "#/tasks" }, { label: taskKeyLabel }]} />

          <section class="task-hero">
            <div class="task-hero-top">
              <div class="task-hero-stack">
                <div class="task-hero-status-row">
                  {runningRun && <LivePulse size={10} />}
                  <StatusMenu status={displayedStage} onChoose={onStatusChoose} />
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
                  {hasTaskSchedules && (
                    <span
                      class={`chip ${hasEnabledSchedule ? "chip-trigger" : "chip-muted"}`}
                      title={automationSummary.next_fire_at ? `Next scheduled run: ${formatDate(automationSummary.next_fire_at)}` : undefined}
                    >
                      <Icon name={hasEnabledSchedule ? "clock" : "minus-circle"} size={10} />
                      {hasEnabledSchedule ? "Scheduled" : "Schedule paused"}
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
                    <Icon name="terminal" size={10} /> Instructions / Request
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

          <TaskPlanCard
            task={task}
            draft={planDraft}
            editing={planEditing}
            saving={planSaving}
            onDraft={setPlanDraft}
            onEdit={() => setPlanEditing(true)}
            onCancel={cancelPlanEdit}
            onSave={savePlan}
          />

          <TaskWorkflowMeta task={task} />

          <TaskAutomationsCard
            taskId={operationTaskId}
            automations={taskAutomations}
            loading={automationsLoading}
            onChanged={() => {
              reload();
              reloadAutomations();
            }}
          />

          <TaskSubtasksCard
            task={task}
            agents={agents}
            title={subtaskTitle}
            owner={subtaskOwner}
            required={subtaskRequired}
            saving={subtaskSaving}
            onTitle={setSubtaskTitle}
            onOwner={(value) => setSubtaskOwner(value || "")}
            onRequired={setSubtaskRequired}
            onCreate={createManualSubtask}
          />

          {showStuckBanner && (
            <Banner
              variant="warn"
              title="This task shows as running but no worker is active."
              detail={runError || undefined}
              actions={
                <>
                  <Button variant="secondary" size="sm" onClick={resetToExecute}>Reset</Button>
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
                  <div class="activity-composer-options">
                    <Checkbox
                      class="activity-rerun-checkbox"
                      checked={commentRerun && !runningRun}
                      disabled={Boolean(runningRun)}
                      onChange={setCommentRerun}
                      label="Rerun task"
                    />
                    <span class="activity-composer-shortcut">Cmd Enter</span>
                  </div>
                  <Button type="submit" variant="primary" disabled={!newComment.trim() || commentSaving}>
                    {commentSaving ? "Posting…" : commentRerun && !runningRun ? "Post & run" : "Post"}
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
                            subscribe={(run.process_status || run.status) === "running"}
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
                          <div class="activity-item-body"><StructuredContent content={item.body} maxHeight={200} /></div>
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
                role="owner"
                value={task.owner_agent || ""}
                onChange={(value) => updateAssignee("owner_agent", value)}
                agents={agents}
                caption={task.owner_agent ? "Plans and runs" : undefined}
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
                    <a key={dependency.id} class="blocked-link" href={`#/tasks/${taskRouteId(dependency)}`}>
                      <span class="truncate">{dependency.title}</span>
                      <StatusPill status={dependency.stage || "plan"} size="sm" />
                    </a>
                  ))}
                </div>
              )}
              {(task.blocks || []).length > 0 && (
                <div class={`dependency-group ${(task.blocked_by || []).length > 0 ? "dependency-group-spaced" : ""}`}>
                  <div class="all-caps">Blocks</div>
                  {(task.blocks || []).map((dependency) => (
                    <a key={dependency.id} class="blocked-link" href={`#/tasks/${taskRouteId(dependency)}`}>
                      <span class="truncate">{dependency.title}</span>
                      <StatusPill status={dependency.stage || "plan"} size="sm" />
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
                    await navigator.clipboard.writeText(taskDisplayKey(task));
                    pushToast("Task key copied", { variant: "success" });
                  } catch {
                    pushToast("Copy failed", { variant: "error" });
                  }
                }}
              >
                Copy task key
              </Button>
              <Button
                variant="secondary"
                iconLeft={<Icon name="copy" size={13} />}
                onClick={async () => {
                  try {
                    const copy = {
                      title: `Copy of ${task.title}`,
                      instructions: task.instructions,
                      owner_agent: task.owner_agent,
                      reviewer_agent: task.reviewer_agent,
                      run_policy: task.run_policy || DEFAULT_RUN_POLICY,
                      tags: task.tags,
                    };
                    const r = await api.createTask(copy);
                    pushToast("Task duplicated", { variant: "success" });
                    navigateHash(`#/tasks/${taskRouteId(r.task)}`);
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

      {/* Stage-transition confirm modal */}
      <Modal
        open={!!statusModal}
        onClose={() => setStatusModal(null)}
        title="Confirm stage change"
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
