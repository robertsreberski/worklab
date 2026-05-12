// §6.x Teams — minimal pane layout. List teams, edit roster/charter/budget,
// view recent lead cycles, and trigger a manual run-lead. Reuses the
// PaneLayout pattern from Agents/Projects.

import { useEffect, useMemo, useState, useCallback, useRef } from "preact/hooks";
import { api } from "../../lib/api.js";
import { useSSE } from "../../lib/useSSE.js";
import { useThrottledCallback } from "../../lib/useThrottledCallback.js";
import { useAppResume } from "../../lib/pageVisibility.js";
import { Button } from "../../components/primitives/Button.jsx";
import { Select } from "../../components/primitives/Select.jsx";
import { Tabs } from "../../components/primitives/Tabs.jsx";
import { Icon } from "../../components/Icon.jsx";
import { PaneLayout } from "../../components/PaneLayout.jsx";
import { PaneRow } from "../../components/PaneRow.jsx";
import { EmptyState, EmptyStateFiltered } from "../../components/EmptyState.jsx";
import { ResourceGroup, ResourceList, ResourceListToolbar } from "../../components/ResourceListToolbar.jsx";
import { ResourceRowChip, ResourceRowId, ResourceRowTags } from "../../components/ResourceRowMeta.jsx";
import { Input } from "../../components/primitives/Input.jsx";
import { Textarea } from "../../components/primitives/Textarea.jsx";
import { MentionableTextarea } from "../../components/MentionableTextarea.jsx";
import { Switch } from "../../components/primitives/Switch.jsx";
import { GoalContractDetails } from "../../components/GoalContractDetails.jsx";
import { EntityBadge } from "../../components/EntityBadge.jsx";
import { FormField } from "../../components/FormField.jsx";
import { FormGrid } from "../../components/FormGrid.jsx";
import { FormSection } from "../../components/FormSection.jsx";
import { Card } from "../../components/Card.jsx";
import { Badge } from "../../components/primitives/Badge.jsx";
import { Chip } from "../../components/primitives/Chip.jsx";
import { StatusDot } from "../../components/primitives/StatusDot.jsx";
import { AgentPicker } from "../../components/AgentPicker.jsx";
import { DetailHead, InlineHead, PanelGrid, SectionGroup, Toolbar } from "../../components/layout/index.js";
import { navigateHash } from "../../lib/navigation.js";
import { pushToast } from "../../lib/toast.js";
import { agentLabel } from "../../lib/agentLinks.js";
import { buildTeamResourceGroups, flattenResourceGroups } from "../../lib/resourceLists.js";
import { useGlobalShortcuts } from "../../lib/useGlobalShortcuts.js";

const GOOD_TEAM_CHECKLIST = [
  "Team charter: define the kind of work this team owns.",
  "Lead: pick a coordinator/orchestrator who can triage and delegate.",
  "Members: add 2-5 specialists with distinct strengths.",
  "Roles: describe when each member should be used.",
  "Assignment: attach the team to a project, or override per task.",
  "Controls: start manual, then add schedules/budgets once the roster works.",
];

function teamDraftFrom(team, members = []) {
  return {
    name: team?.name || "",
    slug: team?.slug || "",
    description: team?.description || "",
    goal: team?.goal || "",
    lead_agent: team?.lead_agent || "",
    status: team?.status || "active",
    schedule_enabled: !!team?.schedule_enabled,
    schedule_interval_minutes: team?.schedule_interval_minutes ?? null,
    daily_budget_usd: team?.daily_budget_usd ?? null,
    per_run_budget_usd: team?.per_run_budget_usd ?? null,
    members: Array.isArray(members) ? members.map((m) => ({
      agent_name: m.agent_name,
      role_description: m.role_description || "",
    })) : [],
  };
}

function intervalDisplay(value) {
  if (!value) return "—";
  return `${value} min`;
}

function statusTone(status) {
  return status === "archived" ? "muted" : "primary";
}

function teamListStatus(status) {
  return status === "archived" ? "disabled" : "enabled";
}

function relativeTime(ts) {
  if (!ts) return "—";
  const ms = Date.now() - Number(ts);
  if (ms < 0) return "now";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

export function leadCycleTaskHref(cycle = {}) {
  const taskId = String(cycle?.task_id ?? "").trim();
  const runId = String(cycle?.run_id ?? cycle?.id ?? "").trim();
  if (!taskId || !runId) return null;
  return `#/tasks/${encodeURIComponent(taskId)}?run=${encodeURIComponent(runId)}`;
}

export function leadCycleRawLogHref(cycle = {}) {
  const runId = String(cycle?.run_id ?? cycle?.id ?? "").trim();
  if (!runId) return null;
  return `/api/runs/${encodeURIComponent(runId)}/raw-log`;
}

function timeUntil(ts, { now = Date.now() } = {}) {
  if (!ts) return null;
  const ms = Number(ts) - now;
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return "due now";
  if (ms < 60_000) return "due in <1m";
  if (ms < 3_600_000) return `due in ${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `due in ${Math.round(ms / 3_600_000)}h`;
  return `due in ${Math.round(ms / 86_400_000)}d`;
}

function leadCycleEventLabel(event) {
  const value = String(event || "").trim();
  if (value === "task_completed") return "after task completed";
  if (value === "task_blocked") return "after task blocked";
  return value ? `after ${value}` : null;
}

export function leadCycleNextReviewLabel(cycle = {}, { now = Date.now() } = {}) {
  return timeUntil(cycle.next_review_due_at, { now }) || leadCycleEventLabel(cycle.next_review_event);
}

function impactCount(value, singular, plural) {
  const count = Number(value) || 0;
  if (count <= 0) return null;
  return `${count} ${count === 1 ? singular : plural}`;
}

export function formatLeadCycleImpact(cycle = {}) {
  return [
    impactCount(cycle.tasks_created, "created", "created"),
    impactCount(cycle.tasks_assigned, "assigned", "assigned"),
    impactCount(cycle.tasks_deleted, "deleted", "deleted"),
    impactCount(cycle.tasks_skipped, "skipped", "skipped"),
    impactCount(cycle.notes_posted, "noted", "noted"),
  ].filter(Boolean);
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function compactText(value) {
  return String(value || "").trim();
}

export function formatLeadCycleRefinement(cycle = {}) {
  const applied = objectValue(cycle.goal_refinement_applied);
  const fields = Array.isArray(applied.applied_fields)
    ? applied.applied_fields.map(compactText).filter(Boolean)
    : [];
  if (applied.applied === true) {
    return {
      status: "applied",
      label: "Goal refined",
      fields,
      rationale: compactText(applied.rationale),
    };
  }
  const skipped = Array.isArray(applied.skipped)
    ? applied.skipped.map((item) => ({
      field: compactText(item?.field || "goal_refinement"),
      reason: compactText(item?.reason || "not applied"),
    })).filter((item) => item.field || item.reason)
    : [];
  if (skipped.length) {
    return {
      status: "skipped",
      label: "Refinement skipped",
      skipped,
      rationale: compactText(applied.rationale),
    };
  }
  return null;
}

export function teamSetupGaps(team = {}, members = [], projects = []) {
  const gaps = [];
  if (!String(team?.goal || "").trim()) {
    gaps.push("Add a team charter so the lead knows what work this team owns.");
  }
  if (!String(team?.lead_agent || "").trim()) {
    gaps.push("Pick a lead agent to coordinate and delegate.");
  }
  if (!Array.isArray(members) || members.length === 0) {
    gaps.push("Add member agents with distinct specialties.");
  }
  if (!Array.isArray(projects) || projects.length === 0) {
    gaps.push("Assign the team to a project or task when it is ready.");
  }
  return gaps;
}

export function goalStatusLabel(goal = {}) {
  if (goal?.contract?.paused_at) return "Paused";
  const status = goal?.goal_status || "in_progress";
  if (status === "complete") return "Complete";
  if (status === "blocked") return "Blocked";
  return "In progress";
}

function goalStatusVariant(goal = {}) {
  if (goal?.contract?.paused_at) return "muted";
  if (goal?.goal_status === "complete") return "primary";
  if (goal?.goal_status === "blocked") return "warn";
  return "primary";
}

function goalGroupKey(goal = {}) {
  if (goal?.contract?.paused_at) return "paused";
  if (goal?.goal_status === "complete") return "complete";
  if (goal?.goal_status === "blocked") return "blocked";
  return "active";
}

export function buildTeamGoalDashboardGroups(goals = []) {
  const meta = {
    active: { key: "active", label: "Active", items: [] },
    blocked: { key: "blocked", label: "Blocked", items: [] },
    paused: { key: "paused", label: "Paused", items: [] },
    complete: { key: "complete", label: "Complete", items: [] },
  };
  for (const goal of goals || []) {
    const key = goalGroupKey(goal);
    meta[key].items.push(goal);
  }
  return ["active", "blocked", "paused", "complete"]
    .map((key) => ({
      ...meta[key],
      items: meta[key].items.sort((a, b) => String(a.project?.name || "").localeCompare(String(b.project?.name || ""))),
    }))
    .filter((group) => group.items.length > 0);
}

function TeamGoalCard({ goal, onRun, onAction, compact = false }) {
  const project = goal?.project || {};
  const statusLabel = goalStatusLabel(goal);
  const paused = Boolean(goal?.contract?.paused_at);
  return (
    <div class={`team-goal-card${compact ? " is-compact" : ""}`}>
      <InlineHead class="team-goal-card-head">
        <div>
          <EntityBadge
            kind="project"
            label={project.name || "Unknown Project"}
            id={project.slug || project.id}
            href={`#/projects/${encodeURIComponent(project.slug || project.id || "")}`}
            class="team-goal-project"
          />
          <div class="team-goal-meta">
            {goal?.team_name && <span>{goal.team_name}</span>}
            {goal?.last_lead_at && <span>lead {relativeTime(goal.last_lead_at)}</span>}
          </div>
        </div>
        <Badge variant={goalStatusVariant(goal)}>{statusLabel}</Badge>
      </InlineHead>
      <GoalContractDetails goal={goal} />
      <Toolbar class="team-goal-actions">
        <Button size="sm" variant="primary" onClick={() => onRun?.(goal)} disabled={!goal?.team_id || !goal?.project_id}>
          Run lead
        </Button>
        <Button size="sm" variant="secondary" onClick={() => onAction?.(goal, paused ? "resume" : "pause")}>
          {paused ? "Resume" : "Pause"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onAction?.(goal, "clear")}>
          Clear
        </Button>
        {goal?.root_task_id && (
          <EntityBadge
            kind="goal"
            label={goal?.contract?.objective || "Goal"}
            id={goal.goal_id || goal.root_task_id}
            href={`#/goals/${encodeURIComponent(goal.goal_id || goal.root_task_id)}`}
            class="team-cycle-link"
          />
        )}
        {goal?.root_task_id && (
          <EntityBadge
            kind="task"
            label={goal?.contract?.objective || "Root task"}
            id={goal.root_task_id}
            href={`#/tasks/${encodeURIComponent(goal.root_task_id)}`}
            class="team-cycle-link"
          />
        )}
      </Toolbar>
    </div>
  );
}

function TeamGoalsDashboard({ goals = [], onRunGoal, onGoalAction }) {
  const groups = buildTeamGoalDashboardGroups(goals);
  return (
    <div class="team-goal-dashboard">
      <InlineHead class="team-goal-dashboard-head">
        <div>
          <h2>Team goals</h2>
          <p class="muted">Durable objectives for each team-project pairing.</p>
        </div>
        <Badge variant="muted">{goals.length} goal{goals.length === 1 ? "" : "s"}</Badge>
      </InlineHead>
      {groups.length ? (
        groups.map((group) => (
          <SectionGroup
            key={group.key}
            class="team-goal-dashboard-group"
            label={group.label}
            count={group.items.length}
          >
            <PanelGrid class="team-goal-grid">
              {group.items.map((goal) => (
                <TeamGoalCard
                  key={`${goal.team_id}:${goal.project_id}`}
                  goal={goal}
                  compact
                  onRun={onRunGoal}
                  onAction={onGoalAction}
                />
              ))}
            </PanelGrid>
          </SectionGroup>
        ))
      ) : (
        <EmptyState
          icon={<Icon name="users" size={20} />}
          title="No team goals"
          body="Assign teams to projects to create per-project goal contracts."
        />
      )}
    </div>
  );
}

function leadRunFailureReason(result) {
  return String(result?.error || result?.message || result?.skipped || "unknown reason");
}

export function formatTeamLeadRunToast(results = []) {
  const rows = Array.isArray(results) ? results : [];
  const okCount = rows.filter((r) => r?.ok).length;
  const skippedCount = Math.max(0, rows.length - okCount);
  if (okCount === rows.length && okCount > 0) {
    return {
      message: `Queued ${okCount} lead cycle${okCount === 1 ? "" : "s"}`,
      variant: "success",
    };
  }
  const firstFailure = rows.find((r) => !r?.ok);
  const reason = leadRunFailureReason(firstFailure);
  if (okCount > 0) {
    return {
      message: `Queued ${okCount} lead cycle${okCount === 1 ? "" : "s"}; skipped ${skippedCount}: ${reason}`,
      variant: "warning",
    };
  }
  return {
    message: `No lead cycles queued: ${reason}`,
    variant: "warning",
  };
}

function TeamSetupGuide() {
  return (
    <Card title="Good team checklist" class="team-setup-card">
      <p class="team-setup-intro">
        Build a small roster around a clear goal. Let the lead coordinate work; use members for specialist execution and review.
      </p>
      <ul class="team-setup-list">
        {GOOD_TEAM_CHECKLIST.map((item) => (
          <li key={item} class="team-setup-item">
            <Icon name="check-circle" size={13} />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function TeamSetupGapsCard({ gaps }) {
  if (!gaps?.length) return null;
  return (
    <Card title="Setup gaps" class="team-setup-card">
      <ul class="team-setup-list">
        {gaps.map((gap) => (
          <li key={gap} class="team-setup-item">
            <Icon name="alert-circle" size={13} />
            <span>{gap}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function MembersEditor({ members, agents, onChange }) {
  function update(idx, patch) {
    const next = members.slice();
    next[idx] = { ...next[idx], ...patch };
    onChange(next);
  }
  function remove(idx) {
    onChange(members.filter((_, i) => i !== idx));
  }
  function add() {
    onChange([...members, { agent_name: "", role_description: "" }]);
  }
  return (
    <div class="team-members-editor">
      {members.length === 0 && (
        <p class="muted">No members yet. Add at least one (the lead is implicitly part of the roster).</p>
      )}
      {members.map((m, idx) => (
        <div class="team-member-row" key={idx}>
          <AgentPicker
            value={m.agent_name || ""}
            onChange={(agentName) => update(idx, { agent_name: agentName || "" })}
            agents={agents}
            placeholder="Pick a member"
            ariaLabel="Team member agent"
          />
          <Input
            value={m.role_description}
            onInput={(e) => update(idx, { role_description: e.currentTarget.value })}
            placeholder="role / responsibility"
          />
          <Button variant="ghost" onClick={() => remove(idx)}>Remove</Button>
        </div>
      ))}
      <Button variant="secondary" onClick={add} iconLeft={<Icon name="plus" size={13} />}>Add member</Button>
    </div>
  );
}

function TeamEditor({ team, members, agents, onSaved, isNew }) {
  const [draft, setDraft] = useState(teamDraftFrom(team, members));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => { setDraft(teamDraftFrom(team, members)); }, [team?.id, members?.length]);

  function update(patch) {
    setDraft((cur) => ({ ...cur, ...patch }));
  }

  async function save() {
    if (!draft.name.trim()) {
      pushToast("Team name is required", { variant: "error" });
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: draft.name.trim(),
        slug: draft.slug.trim() || undefined,
        description: draft.description,
        goal: draft.goal,
        lead_agent: String(draft.lead_agent || "").trim() || null,
        status: draft.status,
        schedule_enabled: !!draft.schedule_enabled,
        schedule_interval_minutes: draft.schedule_interval_minutes,
        daily_budget_usd: draft.daily_budget_usd,
        per_run_budget_usd: draft.per_run_budget_usd,
        members: draft.members
          .map((m) => ({
            ...m,
            agent_name: String(m.agent_name || "").trim(),
          }))
          .filter((m) => m.agent_name),
      };
      let saved;
      if (isNew) {
        saved = await api.createTeam(payload);
      } else {
        saved = await api.patchTeam(team.id, payload);
      }
      pushToast(isNew ? "Team created" : "Team saved", { variant: "success" });
      onSaved?.(saved.team);
      if (isNew) navigateHash(`#/library/teams/${encodeURIComponent(saved.team.slug)}`);
    } catch (err) {
      setError(err.message || "Save failed");
      pushToast(`Save failed: ${err.message}`, { variant: "error" });
    } finally {
      setSaving(false);
    }
  }

  const title = isNew ? "New team" : (draft.name || "Untitled team");
  const slugLabel = isNew ? "Slug after create" : (draft.slug || team?.slug || "");
  const headerActions = (
    <>
      <Button variant="ghost" onClick={() => navigateHash("#/library/teams")}>Cancel</Button>
      <Button variant="primary" loading={saving} onClick={save}>{isNew ? "Create team" : "Save"}</Button>
    </>
  );

  return (
    <>
      <DetailHead
        class="team-detail-head team-edit-head"
        backLabel="All teams"
        onBack={() => navigateHash("#/library/teams")}
        crumbs={[{ label: "Teams", href: "#/library/teams" }, { label: isNew ? "New" : "Edit" }]}
        icon={<Icon name="users" size={16} />}
        kicker={isNew ? "Create team" : "Team editor"}
        title={title}
        meta={(
          <>
            <span class="pane-row-mono">{slugLabel}</span>
            <span class="pane-row-dot">·</span>
            <span>{draft.status || "active"}</span>
          </>
        )}
        actions={headerActions}
      />
      <div class="pane-detail-body entity-detail-body team-edit-body">
        <div class="entity-editor-main">
          {error && <p class="error">{error}</p>}
          <TeamSetupGuide />
          <FormSection kicker="Identity" title="Team">
            <FormGrid columns={2}>
              <FormField label="Name">
                <Input value={draft.name} onInput={(e) => update({ name: e.currentTarget.value })} />
              </FormField>
              <FormField label="Slug" hint={isNew ? "Leave blank to generate from name." : null}>
                <Input value={draft.slug} onInput={(e) => update({ slug: e.currentTarget.value })} placeholder="generated-from-name" />
              </FormField>
              <FormField label="Description" class="span-2">
                <Input value={draft.description} onInput={(e) => update({ description: e.currentTarget.value })} />
              </FormField>
              <FormField label="Team charter" class="span-2">
                <MentionableTextarea rows={4} value={draft.goal} onInput={(e) => update({ goal: e.currentTarget.value })} />
              </FormField>
              <FormField label="Lead agent" class="span-2">
                <AgentPicker
                  class="team-lead-picker"
                  value={draft.lead_agent || ""}
                  onChange={(agentName) => update({ lead_agent: agentName || "" })}
                  agents={agents}
                  placeholder="Pick a lead"
                  ariaLabel="Team lead agent"
                />
              </FormField>
            </FormGrid>
          </FormSection>
          <FormSection kicker="Roster" title="Members">
            <MembersEditor members={draft.members} agents={agents} onChange={(m) => update({ members: m })} />
          </FormSection>
          <FormSection kicker="Automation" title="Schedule">
            <FormGrid columns={2}>
              <FormField switchInside class="span-2">
                <Switch
                  checked={!!draft.schedule_enabled}
                  onChange={(v) => update({ schedule_enabled: v })}
                  label="Run lead cycles on a schedule"
                  description="Periodically fire a worklab.lead_cycle.v1 run for each project this team is assigned to."
                />
              </FormField>
              <FormField label="Interval (minutes)">
                <Input
                  type="number"
                  min="1"
                  step="1"
                  value={draft.schedule_interval_minutes ?? ""}
                  placeholder="e.g. 60"
                  onInput={(e) => {
                    const v = e.currentTarget.value.trim();
                    update({ schedule_interval_minutes: v === "" ? null : Number(v) });
                  }}
                />
              </FormField>
            </FormGrid>
          </FormSection>
          <FormSection
            kicker="Spend"
            title="Budget"
            description="Team budgets replace the retired per-agent budgets. The workspace daily cap in Settings remains a global ceiling."
          >
            <FormGrid columns={2}>
              <FormField label="Daily budget (USD)">
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={draft.daily_budget_usd ?? ""}
                  placeholder="No cap"
                  onInput={(e) => {
                    const v = e.currentTarget.value.trim();
                    update({ daily_budget_usd: v === "" ? null : Number(v) });
                  }}
                />
              </FormField>
              <FormField label="Per-run budget (USD)">
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={draft.per_run_budget_usd ?? ""}
                  placeholder="No cap"
                  onInput={(e) => {
                    const v = e.currentTarget.value.trim();
                    update({ per_run_budget_usd: v === "" ? null : Number(v) });
                  }}
                />
              </FormField>
            </FormGrid>
          </FormSection>
          <Toolbar class="form-actions">
            <Button variant="primary" loading={saving} onClick={save}>{isNew ? "Create team" : "Save"}</Button>
            <Button variant="ghost" onClick={() => navigateHash("#/library/teams")}>Cancel</Button>
          </Toolbar>
        </div>
      </div>
    </>
  );
}

function LeadCycleRow({ cycle }) {
  const taskHref = leadCycleTaskHref(cycle);
  const rawLogHref = leadCycleRawLogHref(cycle);
  const status = cycle?.process_status || cycle?.status || "unknown";
  const statusVariant = cycle?.process_status === "succeeded" ? "primary" : cycle?.process_status === "failed" ? "warn" : "muted";
  const impact = formatLeadCycleImpact(cycle);
  const refinement = formatLeadCycleRefinement(cycle);
  const nextReview = leadCycleNextReviewLabel(cycle);

  return (
    <li class="team-cycle-row">
      <div class="team-cycle-main">
        <div class="team-cycle-meta">
          <span>{relativeTime(cycle?.started_at)}</span>
          <Badge variant={statusVariant}>{status}</Badge>
          {cycle?.goal_status ? <Chip variant="muted">{String(cycle.goal_status).replace("_", " ")}</Chip> : null}
          {cycle?.cost_usd ? <span class="muted">${Number(cycle.cost_usd).toFixed(4)}</span> : null}
          {nextReview ? <span class="team-cycle-review">{nextReview}</span> : null}
        </div>
        {cycle?.summary ? <div class="team-cycle-summary">{cycle.summary}</div> : null}
        {(cycle?.checkpoint_note || cycle?.validation_summary) && (
          <div class="team-cycle-notes">
            {cycle.checkpoint_note ? <span>{cycle.checkpoint_note}</span> : null}
            {cycle.validation_summary ? <span>{cycle.validation_summary}</span> : null}
          </div>
        )}
        {impact.length ? (
          <div class="team-cycle-impact">
            {impact.map((item) => <Chip key={item} variant="muted">{item}</Chip>)}
          </div>
        ) : null}
        {refinement ? (
          <div class={`team-cycle-refinement is-${refinement.status}`}>
            <span>{refinement.label}</span>
            {refinement.fields?.map((field) => <Chip key={field} variant="muted">{field.replace("_", " ")}</Chip>)}
            {refinement.skipped?.map((item) => (
              <span key={`${item.field}:${item.reason}`}>{item.field}: {item.reason}</span>
            ))}
            {refinement.rationale ? <span>{refinement.rationale}</span> : null}
          </div>
        ) : null}
        {Array.isArray(cycle?.task_deletions) && cycle.task_deletions.length ? (
          <div class="team-cycle-tombstones">
            {cycle.task_deletions.map((item) => (
              <span key={`${cycle.run_id || cycle.id}:${item.target_task_id || item.task_key || item.title}`}>
                {(item.task_key || item.target_task_id || "Task")} deleted: {item.title || "Untitled"}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      {(taskHref || rawLogHref) && (
        <Toolbar class="team-cycle-actions">
          {taskHref && (
            <EntityBadge kind="task" label={cycle?.task_title || "Task"} href={taskHref} class="team-cycle-link" />
          )}
          {rawLogHref && (
            <a class="team-cycle-link" href={rawLogHref} target="_blank" rel="noreferrer">
              <Icon name="terminal" size={13} />
              <span>Raw log</span>
            </a>
          )}
        </Toolbar>
      )}
    </li>
  );
}

function TeamDetail({ team, members, projects, cycles, goals = [], onChanged, onRunGoal, onGoalAction }) {
  const [running, setRunning] = useState(false);
  const setupGaps = teamSetupGaps(team, members, projects);
  async function runLeadNow() {
    setRunning(true);
    try {
      const res = await api.runTeamLead(team.id, { reason: "manual" });
      const toast = formatTeamLeadRunToast(res.results || []);
      pushToast(toast.message, { variant: toast.variant });
      onChanged?.();
    } catch (err) {
      pushToast(`Run-lead failed: ${err.message}`, { variant: "error" });
    } finally {
      setRunning(false);
    }
  }

  const headerActions = (
    <>
      <Badge variant={statusTone(team.status)}>{team.status}</Badge>
      <Button variant="primary" loading={running} disabled={!team.lead_agent} onClick={runLeadNow}>Run lead now</Button>
      <Button variant="secondary" onClick={() => navigateHash(`#/library/teams/${encodeURIComponent(team.slug)}/edit`)}>Edit</Button>
    </>
  );

  return (
    <>
      <DetailHead
        class="team-detail-head"
        backLabel="All teams"
        onBack={() => navigateHash("#/library/teams")}
        crumbs={[{ label: "Teams", href: "#/library/teams" }, { label: team.name }]}
        icon={<Icon name="users" size={16} />}
        kicker="Team"
        title={team.name}
        meta={(
          <>
            <span class="pane-row-mono">{team.slug}</span>
            <span class="pane-row-dot">·</span>
            <span>Lead {team.lead_agent || "unassigned"}</span>
            <span class="pane-row-dot">·</span>
            <span>{projects.length} project{projects.length === 1 ? "" : "s"}</span>
          </>
        )}
        actions={headerActions}
      />
      <div class="pane-detail-body entity-detail-body team-detail-body">
        <div class="team-detail-main">
          <Card title="Team charter">
            <p>{team.goal || <em>(no team charter set)</em>}</p>
          </Card>
          <TeamSetupGapsCard gaps={setupGaps} />
          <Card title={`Project goals (${goals.length})`}>
            {goals.length ? (
              <div class="team-goal-grid is-detail">
                {goals.map((goal) => (
                  <TeamGoalCard
                    key={`${goal.team_id}:${goal.project_id}`}
                    goal={goal}
                    onRun={onRunGoal}
                    onAction={onGoalAction}
                  />
                ))}
              </div>
            ) : (
              <p class="muted">Assign this team to a project to create a durable project goal contract.</p>
            )}
          </Card>
          <Card title={`Roster (${members.length})`}>
            {members.length === 0 ? (
              <p class="muted">No members.</p>
            ) : (
              <ul>
                {members.map((m) => (
                  <li key={m.agent_name}>
                    <strong>{m.display_name || m.agent_name}</strong>
                    {m.role_description ? ` — ${m.role_description}` : null}
                    {!m.enabled ? <Badge variant="warn"> disabled </Badge> : null}
                  </li>
                ))}
              </ul>
            )}
            <p class="muted">Lead: {team.lead_agent || "(none)"}</p>
          </Card>
          <Card title={`Assigned projects (${projects.length})`}>
            {projects.length === 0 ? (
              <p class="muted">Not assigned to any project yet. Open a project's edit page and set its team.</p>
            ) : (
              <ul>
                {projects.map((p) => (
                  <li key={p.id}>
                    <EntityBadge kind="project" label={p.name} id={p.slug} href={`#/projects/${encodeURIComponent(p.slug)}`} /> ({p.slug})
                    {p.archived ? <Badge variant="muted"> archived </Badge> : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title={`Recent lead cycles (${cycles.length})`}>
            {cycles.length === 0 ? (
              <p class="muted">No cycles yet.</p>
            ) : (
              <ul class="team-cycle-list">
                {cycles.map((c) => (
                  <LeadCycleRow key={c.id || `${c.task_id}-${c.started_at}`} cycle={c} />
                ))}
              </ul>
            )}
          </Card>
          <Card title="Schedule">
            <p>{team.schedule_enabled ? `Auto-running every ${intervalDisplay(team.schedule_interval_minutes)}` : "Off (lead runs only on task completions or manual trigger)"}</p>
          </Card>
          <Card title="Budget">
            <p>Daily: {team.daily_budget_usd ? `$${Number(team.daily_budget_usd).toFixed(2)}` : "(no cap)"} · Per-run: {team.per_run_budget_usd ? `$${Number(team.per_run_budget_usd).toFixed(2)}` : "(no cap)"}</p>
          </Card>
        </div>
      </div>
    </>
  );
}

function emptyState() {
  return (
    <EmptyState
      icon={<Icon name="users" size={20} />}
      title="No team selected"
      body="Create a team, choose a lead, add specialist members, then assign it to a project or task."
    />
  );
}

export function TeamsTab({ selectedId = null, mode = null }) {
  const [teams, setTeams] = useState([]);
  const [goalsByTeamId, setGoalsByTeamId] = useState({});
  const [agents, setAgents] = useState([]);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("active");
  const [scheduleFilter, setScheduleFilter] = useState("all");
  const [leadFilter, setLeadFilter] = useState("all");
  const [detail, setDetail] = useState(null);
  const searchRef = useRef(null);
  const reloadRef = useRef(null);
  const agentsReloadRef = useRef(null);

  const reload = useCallback(() => {
    reloadRef.current?.abort?.();
    const ctrl = new AbortController();
    reloadRef.current = ctrl;
    api.listTeams({ include_archived: "true" }, { signal: ctrl.signal })
      .then(async (r) => {
        if (ctrl.signal.aborted) return;
        const nextTeams = r.teams || [];
        setTeams(nextTeams);
        const results = await Promise.allSettled(nextTeams.map((team) => (
          api.listTeamGoals(team.id, { include_archived: "true" }, { signal: ctrl.signal })
            .then((res) => [team.id, res.goals || []])
        )));
        if (ctrl.signal.aborted) return;
        const nextGoals = {};
        for (const result of results) {
          if (result.status === "fulfilled") nextGoals[result.value[0]] = result.value[1];
        }
        setGoalsByTeamId(nextGoals);
      })
      .catch((err) => {
        if (err?.name !== "AbortError") {
          setTeams([]);
          setGoalsByTeamId({});
        }
      });
  }, []);
  const reloadSoon = useThrottledCallback(reload, 100);

  const reloadAgents = useCallback(() => {
    agentsReloadRef.current?.abort?.();
    const ctrl = new AbortController();
    agentsReloadRef.current = ctrl;
    api.listAgents({ signal: ctrl.signal })
      .then((r) => { if (!ctrl.signal.aborted) setAgents(r.agents || []); })
      .catch((err) => { if (err?.name !== "AbortError") setAgents([]); });
  }, []);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { reloadAgents(); }, [reloadAgents]);
  useEffect(() => () => {
    reloadRef.current?.abort?.();
    agentsReloadRef.current?.abort?.();
  }, []);
  useSSE("global", (evt) => {
    if (typeof evt?.type === "string" && (evt.type.startsWith("team_") || evt.type.startsWith("lead_cycle_"))) {
      reloadSoon();
      if (selectedId && (evt.id === selectedId || evt.slug === selectedId || evt.team_id === selectedId)) {
        loadDetail();
      }
    }
  });
  useAppResume(reloadSoon);
  useAppResume(reloadAgents);
  useGlobalShortcuts({
    "/": (event) => {
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select?.();
    },
  });

  const loadDetail = useCallback(() => {
    if (!selectedId || selectedId === "new") { setDetail(null); return; }
    api.getTeam(selectedId).then((nextDetail) => {
      setDetail(nextDetail);
      if (nextDetail?.team?.id) {
        setGoalsByTeamId((current) => ({
          ...current,
          [nextDetail.team.id]: nextDetail.goals || [],
        }));
      }
    }).catch(() => setDetail(null));
  }, [selectedId]);
  useEffect(() => { loadDetail(); }, [loadDetail]);

  const runGoal = useCallback(async (goal) => {
    if (!goal?.team_id || !goal?.project_id) return;
    try {
      const res = await api.runTeamLead(goal.team_id, { project_id: goal.project_id, reason: "manual" });
      const toast = formatTeamLeadRunToast(res.results || []);
      pushToast(toast.message, { variant: toast.variant });
      reload();
      loadDetail();
    } catch (err) {
      pushToast(`Run-lead failed: ${err.message}`, { variant: "error" });
    }
  }, [loadDetail, reload]);

  const updateGoal = useCallback(async (goal, action) => {
    if (!goal?.team_id || !goal?.project_id || !action) return;
    try {
      const res = await api.patchTeamGoal(goal.team_id, goal.project_id, { action });
      if (res?.goal) {
        setGoalsByTeamId((current) => ({
          ...current,
          [goal.team_id]: (current[goal.team_id] || []).map((item) => (
            item.project_id === goal.project_id ? res.goal : item
          )),
        }));
      }
      pushToast(`Goal ${action === "clear" ? "cleared" : action === "pause" ? "paused" : "resumed"}`, { variant: "success" });
      reload();
      loadDetail();
    } catch (err) {
      pushToast(`Goal update failed: ${err.message}`, { variant: "error" });
    }
  }, [loadDetail, reload]);

  const groups = useMemo(() => buildTeamResourceGroups(teams, {
    query,
    status: statusFilter,
    schedule: scheduleFilter,
    lead: leadFilter,
  }), [leadFilter, query, scheduleFilter, statusFilter, teams]);
  const filtered = useMemo(() => flattenResourceGroups(groups), [groups]);
  const hasFilter = query.trim() || statusFilter !== "active" || scheduleFilter !== "all" || leadFilter !== "all";
  const statusTabs = useMemo(() => [
    { value: "active", label: "Active", count: teams.filter((team) => team.status !== "archived").length },
    { value: "archived", label: "Archived", count: teams.filter((team) => team.status === "archived").length },
    { value: "all", label: "All", count: teams.length },
  ], [teams]);
  const scheduleOptions = [
    { value: "all", label: "All schedules" },
    { value: "scheduled", label: "Scheduled" },
    { value: "manual", label: "Manual" },
  ];
  const agentLabels = useMemo(() => {
    const labels = new Map();
    for (const agent of agents) {
      if (agent?.name) labels.set(agent.name, agentLabel(agent, agent.name));
    }
    return labels;
  }, [agents]);
  const leadOptions = [
    { value: "all", label: "All leads" },
    { value: "with_lead", label: "Has lead" },
    { value: "no_lead", label: "No lead" },
  ];

  const isNew = selectedId === "new";
  const isEditing = mode === "edit" || isNew;

  let body;
  if (isNew) {
    body = (
      <TeamEditor
        team={null}
        members={[]}
        agents={agents}
        isNew
        onSaved={() => { reload(); }}
      />
    );
  } else if (selectedId) {
    if (!detail) {
      body = <EmptyState icon={<Icon name="users" size={20} />} title="Loading..." body="" />;
    } else if (isEditing) {
      body = (
        <TeamEditor
          team={detail.team}
          members={detail.members || []}
          agents={agents}
          onSaved={() => { reload(); loadDetail(); }}
        />
      );
    } else {
      body = (
        <TeamDetail
          team={detail.team}
          members={detail.members || []}
          projects={detail.projects || []}
          cycles={detail.recent_cycles || []}
          goals={detail.goals || goalsByTeamId[detail.team?.id] || []}
          onChanged={() => { reload(); loadDetail(); }}
          onRunGoal={runGoal}
          onGoalAction={updateGoal}
        />
      );
    }
  } else {
    body = emptyState();
  }

  return (
    <PaneLayout
      hasSelection={!!selectedId}
      onBack={() => navigateHash("#/library/teams")}
      backLabel="Teams"
      listHeader={(
          <ResourceListToolbar
            searchValue={query}
            onSearch={setQuery}
            searchPlaceholder="Search teams..."
            searchAriaLabel="Search teams"
            searchRef={searchRef}
            countLabel={`${filtered.length} shown`}
            actionLabel="New team"
            onAction={() => navigateHash("#/library/teams/new")}
            configTitle="Teams configuration"
            activeConfigCount={[statusFilter !== "active", scheduleFilter !== "all", leadFilter !== "all"].filter(Boolean).length}
          >
            <Tabs value={statusFilter} onChange={setStatusFilter} tabs={statusTabs} ariaLabel="Filter teams by status" class="tabs-pills" />
            <Select class="resource-filter-select" variant="menu" value={scheduleFilter} onChange={setScheduleFilter} options={scheduleOptions} ariaLabel="Filter teams by schedule" />
            <Select class="resource-filter-select" variant="menu" value={leadFilter} onChange={setLeadFilter} options={leadOptions} ariaLabel="Filter teams by lead" />
          </ResourceListToolbar>
        )}
        listBody={(
          <ResourceList>
            {filtered.length === 0 ? (
              hasFilter ? (
                <EmptyStateFiltered body="No teams match." onClearFilters={() => { setQuery(""); setStatusFilter("active"); setScheduleFilter("all"); setLeadFilter("all"); }} />
              ) : (
                <EmptyState
                  icon={<Icon name="users" size={20} />}
                  title="No teams"
                  body="Create a team, choose a lead, add specialist members, then assign it to a project or task."
                />
              )
            ) : groups.map((group) => (
              <ResourceGroup key={group.key} group={group}>
                {group.items.map((team) => (
                  <PaneRow
                    key={team.id}
                    active={team.id === selectedId || team.slug === selectedId}
                    href={`#/library/teams/${encodeURIComponent(team.slug)}`}
                    leading={<span class="team-row-leading"><Icon name="users" size={12} /></span>}
                    title={team.name}
                    sub={(
                      <span class="pane-row-substack">
                        {(team.goal || team.description) && <span class="pane-row-description">{team.goal || team.description}</span>}
                        <ResourceRowTags>
                          <ResourceRowId>{team.slug}</ResourceRowId>
                          {team.lead_agent && <ResourceRowChip tone="entity" icon="user">lead {agentLabels.get(team.lead_agent) || "Unknown Agent"}</ResourceRowChip>}
                          {team.schedule_enabled && <ResourceRowChip tone="accent" icon="clock">scheduled</ResourceRowChip>}
                          <ResourceRowChip tone="info" icon="users">{team.member_count ?? 0} member{(team.member_count ?? 0) === 1 ? "" : "s"}</ResourceRowChip>
                          {Number(team.project_count || 0) > 0 && <ResourceRowChip tone="info" icon="folder">{team.project_count} project{team.project_count === 1 ? "" : "s"}</ResourceRowChip>}
                        </ResourceRowTags>
                      </span>
                    )}
                    trailing={(
                      <span class="pane-row-summary pane-row-summary-metrics">
                        <span class="team-list-status" title={team.status} aria-label={`Team status: ${team.status}`}>
                          <StatusDot status={teamListStatus(team.status)} size={8} />
                        </span>
                        <span>{team.status || "active"}</span>
                      </span>
                    )}
                  />
                ))}
              </ResourceGroup>
            ))}
          </ResourceList>
        )}
      detail={body}
      listFirst
      fullDetail={!!selectedId}
      class="resource-list-layout"
    />
  );
}
