import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api } from "../lib/api.js";
import { navigateHash } from "../lib/navigation.js";
import { useSSE } from "../lib/useSSE.js";
import { useThrottledCallback } from "../lib/useThrottledCallback.js";
import { useAppResume } from "../lib/pageVisibility.js";
import { useGlobalShortcuts } from "../lib/useGlobalShortcuts.js";
import { pushToast } from "../lib/toast.js";
import { AppShell, MobileTopbar } from "../components/AppShell.jsx";
import { EntityChromeBridge } from "../components/EntityChromeBridge.jsx";
import { PaneLayout } from "../components/PaneLayout.jsx";
import { PaneRow } from "../components/PaneRow.jsx";
import { ResourceGroup, ResourceList, ResourceListToolbar } from "../components/ResourceListToolbar.jsx";
import { ResourceRowChip, ResourceRowTags } from "../components/ResourceRowMeta.jsx";
import { GoalContractDetails } from "../components/GoalContractDetails.jsx";
import { EntityBadge } from "../components/EntityBadge.jsx";
import { DetailHead, SectionStack, Toolbar } from "../components/layout/index.js";
import { Button } from "../components/primitives/Button.jsx";
import { Select } from "../components/primitives/Select.jsx";
import { ProjectPicker } from "../components/ProjectPicker.jsx";
import { Tabs } from "../components/primitives/Tabs.jsx";
import { Input } from "../components/primitives/Input.jsx";
import { Textarea } from "../components/primitives/Textarea.jsx";
import { MentionableTextarea } from "../components/MentionableTextarea.jsx";
import { FormField } from "../components/FormField.jsx";
import { FormGrid } from "../components/FormGrid.jsx";
import { FormSection } from "../components/FormSection.jsx";
import { Badge } from "../components/primitives/Badge.jsx";
import { Chip } from "../components/primitives/Chip.jsx";
import { Card } from "../components/Card.jsx";
import { EmptyState, EmptyStateFiltered } from "../components/EmptyState.jsx";
import { LoadingState } from "../components/LoadingState.jsx";
import { Icon } from "../components/Icon.jsx";

const GOAL_GROUPS = [
  { key: "active", label: "Active" },
  { key: "blocked", label: "Blocked" },
  { key: "paused", label: "Paused" },
  { key: "complete", label: "Complete" },
];

function text(value) {
  return String(value || "").trim();
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

export function goalId(goal = {}) {
  return text(goal.goal_id || goal.id || goal.root_task_id);
}

export function goalRouteHash(goal = {}) {
  const id = goalId(goal);
  return id ? `#/goals/${encodeURIComponent(id)}` : "#/goals";
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
  if (goal?.goal_status === "blocked") return "warn";
  if (goal?.goal_status === "complete") return "trigger";
  return "primary";
}

function goalGroupKey(goal = {}) {
  if (goal?.contract?.paused_at) return "paused";
  if (goal?.goal_status === "blocked") return "blocked";
  if (goal?.goal_status === "complete") return "complete";
  return "active";
}

function matchesQuery(goal, query) {
  const q = text(query).toLowerCase();
  if (!q) return true;
  const contract = goal?.contract || {};
  return [
    goal?.team_name,
    goal?.team_slug,
    goal?.project?.name,
    goal?.project?.slug,
    contract.objective,
    contract.stopping_condition,
    contract.validation_loop,
    goal?.goal_status_reason,
    ...(contract.constraints || []),
  ].some((value) => text(value).toLowerCase().includes(q));
}

function matchesState(goal, state) {
  if (!state || state === "all") return true;
  return goalGroupKey(goal) === state;
}

export function buildGoalResourceGroups(goals = [], { query = "", state = "all" } = {}) {
  const buckets = new Map(GOAL_GROUPS.map((group) => [group.key, { ...group, items: [] }]));
  for (const goal of goals || []) {
    if (!matchesState(goal, state)) continue;
    if (!matchesQuery(goal, query)) continue;
    const key = goalGroupKey(goal);
    buckets.get(key)?.items.push(goal);
  }
  return GOAL_GROUPS
    .map((group) => ({
      ...buckets.get(group.key),
      items: (buckets.get(group.key)?.items || []).sort((left, right) => {
        const project = text(left.project?.name || left.project?.slug).localeCompare(text(right.project?.name || right.project?.slug));
        if (project !== 0) return project;
        return text(left.team_name || left.team_slug).localeCompare(text(right.team_name || right.team_slug));
      }),
    }))
    .filter((group) => group.items.length > 0);
}

function latestCheckpoint(goal = {}) {
  const notes = Array.isArray(goal?.contract?.checkpoint_notes) ? goal.contract.checkpoint_notes : [];
  return notes[notes.length - 1] || null;
}

function leadCycleRunId(cycle = {}) {
  return text(cycle.run_id || cycle.id);
}

function leadCycleStatusVariant(cycle = {}) {
  const status = cycle?.process_status || cycle?.status || "";
  if (status === "succeeded" || status === "complete") return "primary";
  if (status === "failed" || status === "error" || status === "cancelled") return "warn";
  return "muted";
}

function leadCycleStatus(cycle = {}) {
  return text(cycle.process_status || cycle.status || "unknown");
}

function eventLabel(event) {
  if (event === "task_completed") return "after task completed";
  if (event === "task_blocked") return "after task blocked";
  return text(event) ? `after ${text(event)}` : null;
}

function formatImpactCount(value, singular, plural) {
  const count = Number(value) || 0;
  if (count <= 0) return null;
  return `${count} ${count === 1 ? singular : plural}`;
}

function leadCycleImpact(cycle = {}) {
  return [
    formatImpactCount(cycle.tasks_created, "created", "created"),
    formatImpactCount(cycle.tasks_assigned, "assigned", "assigned"),
    formatImpactCount(cycle.tasks_deleted, "deleted", "deleted"),
    formatImpactCount(cycle.tasks_skipped, "skipped", "skipped"),
    formatImpactCount(cycle.notes_posted, "noted", "noted"),
  ].filter(Boolean);
}

function deletionRows(cycle = {}) {
  return Array.isArray(cycle.task_deletions) ? cycle.task_deletions : [];
}

function leadCycleDecisionText(cycle = {}) {
  return text(cycle.summary || cycle.checkpoint_note || cycle.validation_summary);
}

function leadCycleDetailTexts(cycle = {}, decision = "") {
  return [cycle.checkpoint_note, cycle.validation_summary]
    .map((item) => text(item))
    .filter(Boolean)
    .filter((item, index, items) => item !== decision && items.indexOf(item) === index);
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function goalRefinementSummary(cycle = {}) {
  const applied = objectValue(cycle.goal_refinement_applied);
  const fields = Array.isArray(applied.applied_fields)
    ? applied.applied_fields.map(text).filter(Boolean)
    : [];
  if (applied.applied === true) {
    return {
      status: "applied",
      label: "Goal refined",
      fields,
      rationale: text(applied.rationale),
      patch: objectValue(applied.patch_applied),
    };
  }
  const skipped = Array.isArray(applied.skipped)
    ? applied.skipped.map((item) => ({
      field: text(item?.field || "goal_refinement"),
      reason: text(item?.reason || "not applied"),
    })).filter((item) => item.field || item.reason)
    : [];
  if (skipped.length) {
    return {
      status: "skipped",
      label: "Refinement skipped",
      skipped,
      rationale: text(applied.rationale),
    };
  }
  return null;
}

export function goalLeadCycleTimeline(goal = {}, { now = Date.now() } = {}) {
  const source = Array.isArray(goal?.cycles) && goal.cycles.length
    ? goal.cycles
    : goal?.latest_cycle ? [goal.latest_cycle] : [];
  return source.map((cycle, index) => {
    const runId = leadCycleRunId(cycle);
    const taskId = text(cycle.task_id || goal.root_task_id);
    const dueLabel = timeUntil(cycle.next_review_due_at, { now });
    const reviewLabel = dueLabel || eventLabel(cycle.next_review_event);
    return {
      id: runId || `${cycle.started_at || index}`,
      run_id: runId || null,
      task_id: taskId || null,
      href: runId && taskId ? `#/tasks/${encodeURIComponent(taskId)}?run=${encodeURIComponent(runId)}` : null,
      status: leadCycleStatus(cycle),
      status_variant: leadCycleStatusVariant(cycle),
      started_label: cycle.started_at ? relativeTime(cycle.started_at) : null,
      summary: text(cycle.summary),
      checkpoint_note: text(cycle.checkpoint_note),
      validation_summary: text(cycle.validation_summary),
      goal_status: text(cycle.goal_status),
      goal_refinement: objectValue(cycle.goal_refinement),
      goal_refinement_applied: objectValue(cycle.goal_refinement_applied),
      refinement: goalRefinementSummary(cycle),
      review_label: reviewLabel,
      event_label: eventLabel(cycle.next_review_event),
      impact: leadCycleImpact(cycle),
      deletions: deletionRows(cycle),
      tasks_created: Number(cycle.tasks_created) || 0,
      tasks_assigned: Number(cycle.tasks_assigned) || 0,
      tasks_deleted: Number(cycle.tasks_deleted) || 0,
      tasks_skipped: Number(cycle.tasks_skipped) || 0,
      notes_posted: Number(cycle.notes_posted) || 0,
      cost_usd: cycle.cost_usd ?? null,
    };
  });
}

export function goalCockpitSummary(goal = {}, { now = Date.now() } = {}) {
  const rows = goalLeadCycleTimeline(goal, { now });
  const latest = rows[0] || null;
  const readiness = goal?.readiness || goalReadiness(goal);
  const nextReview = latest?.review_label || "Not scheduled";
  const leadTasks = Array.isArray(goal?.lead_tasks) ? goal.lead_tasks : [];
  const decisionCycle = rows.find((row) => leadCycleDecisionText(row)) || null;
  const latestDecision = decisionCycle ? leadCycleDecisionText(decisionCycle) : "";
  return {
    latest,
    decisionCycle,
    latestDecision,
    latestDetails: decisionCycle ? leadCycleDetailTexts(decisionCycle, latestDecision) : [],
    leadTasks,
    stateStrip: [
      { label: "State", value: goalStatusLabel(goal) },
      { label: "Definition", value: readiness.ready ? "Ready" : `${readiness.missing.length} missing` },
      { label: "Last cycle", value: goal.last_lead_at ? relativeTime(goal.last_lead_at) : "None" },
      { label: "Next review", value: nextReview },
    ],
    ledger: [
      { key: "created", label: "Created", value: Number(latest?.tasks_created ?? goal?.latest_cycle?.tasks_created ?? 0) || 0 },
      { key: "assigned", label: "Assigned", value: Number(latest?.tasks_assigned ?? goal?.latest_cycle?.tasks_assigned ?? 0) || 0 },
      { key: "deleted", label: "Deleted", value: Number(latest?.tasks_deleted ?? goal?.latest_cycle?.tasks_deleted ?? 0) || 0 },
      { key: "skipped", label: "Skipped", value: Number(latest?.tasks_skipped ?? goal?.latest_cycle?.tasks_skipped ?? 0) || 0 },
      { key: "noted", label: "Noted", value: Number(latest?.notes_posted ?? goal?.latest_cycle?.notes_posted ?? 0) || 0 },
    ],
  };
}

function constraintsToText(value) {
  return Array.isArray(value) ? value.join("\n") : "";
}

function constraintsFromText(value) {
  return String(value || "")
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function isAllowedGoalLinkHref(value) {
  const href = text(value);
  if (!href) return false;
  if (/^https?:\/\//i.test(href)) return true;
  if (href.startsWith("#/")) return true;
  return href.startsWith("/") && !href.startsWith("//");
}

function normalizeGoalLinkDraft(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const href = text(typeof item === "string" ? item : item?.url);
    if (!isAllowedGoalLinkHref(href) || seen.has(href)) continue;
    seen.add(href);
    const label = text(typeof item === "string" ? "" : item?.label) || href;
    out.push({ label, url: href });
  }
  return out;
}

function linksToText(value) {
  return normalizeGoalLinkDraft(value)
    .map((link) => (link.label && link.label !== link.url ? `${link.label} | ${link.url}` : link.url))
    .join("\n");
}

function linksFromText(value) {
  const lines = String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return normalizeGoalLinkDraft(lines.map((line) => {
    const separator = line.includes("|") ? "|" : null;
    if (!separator) return { label: "", url: line };
    const [rawLabel, ...rest] = line.split(separator);
    return { label: rawLabel.trim(), url: rest.join(separator).trim() };
  }));
}

export function goalReadiness(value = {}) {
  const contract = value?.contract || value || {};
  const missing = [];
  if (!text(contract.objective)) missing.push("objective");
  if (!text(contract.stopping_condition)) missing.push("stopping_condition");
  if (!text(contract.validation_loop)) missing.push("validation_loop");
  return { ready: missing.length === 0, missing };
}

export function goalAssignmentState({ draft = {}, projects = [], teams = [], isNew = false } = {}) {
  const selectedProject = projects.find((project) => project.id === draft.project_id || project.slug === draft.project_id) || null;
  const lockedTeamId = selectedProject?.team_id || "";
  const lockedTeam = lockedTeamId
    ? teams.find((team) => team.id === lockedTeamId || team.slug === lockedTeamId) || { id: lockedTeamId, name: lockedTeamId }
    : null;
  const effectiveTeamId = lockedTeamId || draft.team_id || "";
  const visibleTeams = lockedTeam ? [lockedTeam] : teams;
  return {
    selectedProject,
    lockedTeam,
    effectiveTeamId,
    teamLocked: Boolean(isNew && lockedTeamId),
    teamRequired: Boolean(isNew && !lockedTeamId),
    teamOptions: visibleTeams.map((team) => ({
      value: team.id,
      label: team.name || team.slug || team.id,
      description: team.goal || team.description || team.slug || (team.id === lockedTeamId ? "Project team" : ""),
    })),
  };
}

export function goalDraftFrom(goal = {}) {
  const contract = goal?.contract || {};
  return {
    team_id: goal?.team_id || "",
    project_id: goal?.project_id || "",
    north_star: contract.north_star || "",
    objective: contract.objective || "",
    stopping_condition: contract.stopping_condition || "",
    validation_loop: contract.validation_loop || "",
    links_text: linksToText(contract.links),
    constraints_text: constraintsToText(contract.constraints),
  };
}

function goalProjectLabel(goal = {}) {
  return goal.project?.name || goal.project?.slug || goal.project_id || "Untitled project";
}

function goalTeamLabel(goal = {}) {
  return goal.team_name || goal.team_slug || goal.team_id || "Unassigned team";
}

export function goalReferenceLinks(goal = {}) {
  const links = [];
  const projectHrefId = text(goal.project?.slug || goal.project_id);
  const teamHrefId = text(goal.team_slug || goal.team_id);
  const rootTaskId = text(goal.root_task_id);
  const latest = goal.latest_cycle || null;
  if (projectHrefId) {
    links.push({ kind: "internal", label: "Project", href: `#/projects/${encodeURIComponent(projectHrefId)}` });
  }
  if (teamHrefId) {
    links.push({ kind: "internal", label: "Team", href: `#/library/teams/${encodeURIComponent(teamHrefId)}` });
  }
  const latestRunId = leadCycleRunId(latest);
  if (latestRunId && latest?.task_id) {
    links.push({
      kind: "internal",
      label: "Latest lead cycle",
      href: `#/tasks/${encodeURIComponent(latest.task_id)}?run=${encodeURIComponent(latestRunId)}`,
    });
  }
  if (rootTaskId) {
    links.push({ kind: "internal", label: "Lead-cycle anchor", href: `#/tasks/${encodeURIComponent(rootTaskId)}` });
  }
  for (const link of normalizeGoalLinkDraft(goal.contract?.links)) {
    links.push({
      kind: "reference",
      label: link.label,
      href: link.url,
      external: /^https?:\/\//i.test(link.url),
    });
  }
  return links;
}

function GoalRow({ goal, active }) {
  const checkpoint = latestCheckpoint(goal);
  return (
    <PaneRow
      active={active}
      href={goalRouteHash(goal)}
      leading={<span class="goal-row-leading"><Icon name="target" size={12} /></span>}
      title={goalProjectLabel(goal)}
      sub={(
        <span class="pane-row-substack">
          <span class="pane-row-description">{goal.contract?.objective || "(no objective set)"}</span>
          <ResourceRowTags>
            <ResourceRowChip tone="entity" icon="users">team {goalTeamLabel(goal)}</ResourceRowChip>
            {goal.last_lead_at && <ResourceRowChip tone="info" icon="clock">lead {relativeTime(goal.last_lead_at)}</ResourceRowChip>}
            {checkpoint && <ResourceRowChip tone="accent" icon="check-circle">checkpoint</ResourceRowChip>}
          </ResourceRowTags>
        </span>
      )}
      trailing={<Badge variant={goalStatusVariant(goal)}>{goalStatusLabel(goal)}</Badge>}
    />
  );
}

function LeadCycleTimeline({ goal }) {
  const rows = goalLeadCycleTimeline(goal);
  if (!rows.length) return <p class="muted">No lead-cycle runs yet.</p>;
  return (
    <ol class="goal-cycle-timeline">
      {rows.map((row) => (
        <li key={row.id} class="goal-cycle-row">
          <div class="goal-cycle-marker" aria-hidden="true" />
          <div class="goal-cycle-content">
            <div class="goal-cycle-head">
              <Badge variant={row.status_variant}>{row.status}</Badge>
              {row.goal_status ? <Chip variant="muted">{row.goal_status.replace("_", " ")}</Chip> : null}
              {row.started_label ? <span class="muted">{row.started_label}</span> : null}
              {row.review_label ? <span class="goal-cycle-review">{row.review_label}</span> : null}
            </div>
            <div class="goal-cycle-summary">{row.summary || row.checkpoint_note || "Lead cycle completed."}</div>
            {(row.checkpoint_note || row.validation_summary) && (
              <div class="goal-cycle-notes">
                {row.checkpoint_note && <span>{row.checkpoint_note}</span>}
                {row.validation_summary && <span>{row.validation_summary}</span>}
              </div>
            )}
            {row.refinement ? (
              <div class={`goal-cycle-refinement is-${row.refinement.status}`}>
                <span>{row.refinement.label}</span>
                {row.refinement.fields?.map((field) => <Chip key={field} variant="muted">{field.replace("_", " ")}</Chip>)}
                {row.refinement.skipped?.map((item) => (
                  <span key={`${item.field}:${item.reason}`}>{item.field}: {item.reason}</span>
                ))}
                {row.refinement.rationale ? <span>{row.refinement.rationale}</span> : null}
              </div>
            ) : null}
            <div class="goal-cycle-foot">
              {row.impact.map((item) => <Chip key={item} variant="muted">{item}</Chip>)}
              {row.cost_usd ? <span class="muted">${Number(row.cost_usd).toFixed(4)}</span> : null}
              {row.href && <EntityBadge kind="run" label="Open run" id={row.run_id} href={row.href} />}
            </div>
            {row.deletions.length ? (
              <div class="goal-cycle-deletions">
                {row.deletions.map((item) => (
                  <span key={`${row.id}:${item.target_task_id || item.task_key || item.title}`}>
                    {(item.task_key || item.target_task_id || "Task")} deleted: {item.title || "Untitled"}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

function LeadCycleCockpit({ goal }) {
  const cockpit = goalCockpitSummary(goal);
  return (
    <Card title="Lead cycle cockpit">
      <div class="goal-cockpit">
        <div class="goal-cockpit-strip">
          {cockpit.stateStrip.map((item) => (
            <div class="goal-cockpit-stat" key={item.label}>
              <span>{item.label}</span>
              <strong>{item.value}</strong>
            </div>
          ))}
        </div>
        <div class="goal-cockpit-decision">
          <div>
            <span class="muted">Latest decision</span>
            <strong title={cockpit.latestDecision || undefined}>{cockpit.latestDecision || "No lead-cycle decision yet."}</strong>
          </div>
          {cockpit.latestDetails.map((detail, index) => (
            <p key={detail} class={index > 0 ? "muted" : undefined} title={detail}>{detail}</p>
          ))}
        </div>
        <div class="goal-cockpit-ledger" aria-label="Lead cycle task changes">
          {cockpit.ledger.map((item) => (
            <div class={`goal-cockpit-ledger-item is-${item.key}${item.value > 0 ? " has-value" : ""}`} key={item.key}>
              <span>{item.label}</span>
              <strong>{item.value}</strong>
            </div>
          ))}
        </div>
        <div class="goal-lead-roster">
          <div class="goal-roster-head">
            <span class="muted">Lead-created task roster</span>
            <Chip variant="muted">{cockpit.leadTasks.length}</Chip>
          </div>
          {cockpit.leadTasks.length ? (
            <ul>
              {cockpit.leadTasks.map((task) => (
                <li key={task.id}>
                  <EntityBadge kind="task" label={task.task_key || task.title || task.id} href={`#/tasks/${encodeURIComponent(task.id)}`} />
                  <span>{task.title}</span>
                  <Chip variant="muted">{String(task.stage || "task").replace("_", " ")}</Chip>
                  {task.owner_agent ? <span class="muted">{task.owner_agent}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p class="muted">No active lead-created tasks.</p>
          )}
        </div>
      </div>
    </Card>
  );
}

function GoalDetail({ goal, onChanged }) {
  const [running, setRunning] = useState(false);
  const [updating, setUpdating] = useState(false);
  const paused = Boolean(goal?.contract?.paused_at);
  const readiness = goal?.readiness || goalReadiness(goal);
  const referenceLinks = goalReferenceLinks(goal);

  async function runLeadCycle() {
    setRunning(true);
    try {
      const res = await api.runGoal(goal.goal_id, { reason: "manual" });
      pushToast(res?.runId ? "Lead cycle queued" : "Goal run requested", { variant: "success" });
      onChanged?.();
    } catch (err) {
      pushToast(`Lead cycle failed: ${err.message}`, { variant: "error" });
    } finally {
      setRunning(false);
    }
  }

  async function setPaused() {
    setUpdating(true);
    try {
      await api.patchGoal(goal.goal_id, { action: paused ? "resume" : "pause" });
      pushToast(paused ? "Goal resumed" : "Goal paused", { variant: "success" });
      onChanged?.();
    } catch (err) {
      pushToast(`Goal update failed: ${err.message}`, { variant: "error" });
    } finally {
      setUpdating(false);
    }
  }

  const cycleTimeline = goalLeadCycleTimeline(goal);
  const detailActions = (
    <>
      <Button variant="primary" loading={running} onClick={runLeadCycle} iconLeft={<Icon name="play" size={13} />}>
        Run lead cycle
      </Button>
      <Button variant="secondary" loading={updating} onClick={setPaused}>
        {paused ? "Resume" : "Pause"}
      </Button>
      <Button variant="secondary" onClick={() => navigateHash(`${goalRouteHash(goal)}/edit`)}>
        Edit
      </Button>
    </>
  );

  return (
    <>
      <EntityChromeBridge
        chrome={{
          mobileTopbar: <MobileTopbar title={goalProjectLabel(goal)} backLabel="Goals" onBack={() => navigateHash("#/goals")} />,
          mobileActionDock: detailActions,
        }}
      />
      <DetailHead
        class="goal-detail-head"
        backLabel="All goals"
        onBack={() => navigateHash("#/goals")}
        crumbs={[{ label: "Goals", href: "#/goals" }, { label: goalProjectLabel(goal) }]}
        icon={<Icon name="target" size={16} />}
        kicker="Goal"
        title={goalProjectLabel(goal)}
        meta={(
          <>
            <span>{goalTeamLabel(goal)}</span>
            <span class="pane-row-dot">·</span>
            <span>{goalStatusLabel(goal)}</span>
          </>
        )}
        actions={detailActions}
      />
      <div class="pane-detail-body entity-detail-body goal-detail-body">
        <SectionStack class="goal-detail-grid">
          <LeadCycleCockpit goal={goal} />
          {!readiness.ready && (
            <Card title="Goal readiness">
              <div class="goal-readiness-list" role="status">
                {readiness.missing.map((field) => (
                  <span key={field}>{field === "stopping_condition" ? "Done when" : field === "validation_loop" ? "Validate with" : "Objective"}</span>
                ))}
              </div>
            </Card>
          )}
          <Card title="Contract">
            <GoalContractDetails goal={goal} />
          </Card>
          <Card title="Links">
            {referenceLinks.length ? (
              <Toolbar class="goal-link-list" align="start">
                {referenceLinks.map((link) => (
                  <a
                    key={`${link.kind}:${link.href}`}
                    href={link.href}
                    target={link.external ? "_blank" : undefined}
                    rel={link.external ? "noopener noreferrer" : undefined}
                    class={`goal-link-row is-${link.kind}`}
                  >
                    <Icon name={link.kind === "reference" ? "external" : "link"} size={13} />
                    <span>{link.label}</span>
                  </a>
                ))}
              </Toolbar>
            ) : (
              <p class="muted">No links attached.</p>
            )}
          </Card>
          <Card title={`Lead cycle timeline (${cycleTimeline.length})`}>
            <LeadCycleTimeline goal={goal} />
          </Card>
        </SectionStack>
      </div>
    </>
  );
}

function GoalEditor({ goal = null, teams = [], projects = [], isNew = false, onSaved }) {
  const [draft, setDraft] = useState(goalDraftFrom(goal));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setDraft(goalDraftFrom(goal));
  }, [goal?.goal_id]);

  function update(patch) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  async function save() {
    const assignment = goalAssignmentState({ draft, projects, teams, isNew });
    if (isNew && !assignment.effectiveTeamId) {
      pushToast("Choose a team", { variant: "error" });
      return;
    }
    if (isNew && !draft.project_id) {
      pushToast("Choose a project", { variant: "error" });
      return;
    }
    setSaving(true);
    setError(null);
    const payload = {
      team_id: assignment.effectiveTeamId || undefined,
      project_id: draft.project_id || undefined,
      north_star: draft.north_star,
      objective: draft.objective,
      stopping_condition: draft.stopping_condition,
      validation_loop: draft.validation_loop,
      links: linksFromText(draft.links_text),
      constraints: constraintsFromText(draft.constraints_text),
    };
    try {
      const saved = isNew
        ? await api.createGoal(payload)
        : await api.patchGoal(goal.goal_id, payload);
      pushToast(isNew ? "Goal created" : "Goal saved", { variant: "success" });
      onSaved?.(saved.goal);
      navigateHash(goalRouteHash(saved.goal));
    } catch (err) {
      setError(err.message || "Save failed");
      pushToast(`Save failed: ${err.message}`, { variant: "error" });
    } finally {
      setSaving(false);
    }
  }
  const cancel = () => navigateHash(isNew ? "#/goals" : goalRouteHash(goal));
  const saveLabel = isNew ? "Create goal" : "Save";
  const editorActions = (
    <>
      <Button variant="ghost" onClick={cancel}>Cancel</Button>
      <Button variant="primary" loading={saving} onClick={save}>{saveLabel}</Button>
    </>
  );

  const assignment = goalAssignmentState({ draft, projects, teams, isNew });
  const readiness = goalReadiness(draft);

  return (
    <>
      <EntityChromeBridge
        chrome={{
          mobileTopbar: <MobileTopbar title={isNew ? "New goal" : goalProjectLabel(goal)} backLabel="Goals" onBack={cancel} />,
          mobileActionDock: (
            <>
              <Button variant="secondary" onClick={cancel}>Cancel</Button>
              <Button variant="primary" loading={saving} onClick={save}>{saveLabel}</Button>
            </>
          ),
        }}
      />
      <DetailHead
        class="goal-detail-head goal-edit-head"
        backLabel="All goals"
        onBack={() => navigateHash("#/goals")}
        crumbs={[{ label: "Goals", href: "#/goals" }, { label: isNew ? "New" : "Edit" }]}
        icon={<Icon name="target" size={16} />}
        kicker={isNew ? "Create goal" : "Goal editor"}
        title={isNew ? "New goal" : goalProjectLabel(goal)}
        actions={editorActions}
      />
      <div class="pane-detail-body entity-detail-body goal-edit-body">
        <SectionStack class="goal-editor">
          {error && <p class="error">{error}</p>}
          <FormSection kicker="Assignment" title="Assignment">
            <FormGrid columns={2}>
              <FormField label="Team">
                <Select
                  value={assignment.effectiveTeamId}
                  onChange={(value) => update({ team_id: value })}
                  options={assignment.teamOptions}
                  placeholder="Choose team"
                  disabled={!isNew || assignment.teamLocked}
                  searchable
                />
                <div class="field-hint">
                  {assignment.teamLocked ? "This project already belongs to this team." : "Choose a team only for unassigned projects."}
                </div>
              </FormField>
              <FormField label="Project">
                <ProjectPicker
                  value={draft.project_id}
                  onChange={(value) => {
                    const nextProject = projects.find((project) => project.id === value || project.slug === value);
                    update({ project_id: value, team_id: nextProject?.team_id ? "" : draft.team_id });
                  }}
                  projects={projects}
                  allowClear={false}
                  placeholder="Choose project"
                  disabled={!isNew}
                />
              </FormField>
            </FormGrid>
          </FormSection>
          <FormSection kicker="Contract" title="Contract">
            <div class={`goal-readiness-banner ${readiness.ready ? "is-ready" : "is-missing"}`}>
              <Icon name={readiness.ready ? "check-circle" : "alert-triangle"} size={14} />
              <span>{readiness.ready ? "Goal definition has an objective, completion condition, and validation loop." : `Missing: ${readiness.missing.map((field) => (field === "stopping_condition" ? "done when" : field === "validation_loop" ? "validate with" : "objective")).join(", ")}`}</span>
            </div>
            <FormGrid columns={2}>
              <FormField label="North star" class="span-2">
                <MentionableTextarea rows={3} value={draft.north_star} onInput={(event) => update({ north_star: event.currentTarget.value })} />
              </FormField>
              <FormField label="Objective" class="span-2">
                <MentionableTextarea rows={4} value={draft.objective} onInput={(event) => update({ objective: event.currentTarget.value })} />
              </FormField>
              <FormField label="Done when">
                <Textarea rows={3} value={draft.stopping_condition} onInput={(event) => update({ stopping_condition: event.currentTarget.value })} />
              </FormField>
              <FormField label="Validate with">
                <Textarea rows={3} value={draft.validation_loop} onInput={(event) => update({ validation_loop: event.currentTarget.value })} />
              </FormField>
              <FormField label="Links" class="span-2">
                <Textarea rows={3} value={draft.links_text} placeholder="Label | https://example.com/reference" onInput={(event) => update({ links_text: event.currentTarget.value })} />
              </FormField>
              <FormField label="Constraints" class="span-2">
                <MentionableTextarea rows={4} value={draft.constraints_text} onInput={(event) => update({ constraints_text: event.currentTarget.value })} />
              </FormField>
            </FormGrid>
          </FormSection>
        </SectionStack>
      </div>
    </>
  );
}

function emptyDetail() {
  return (
    <EmptyState
      icon={<Icon name="target" size={28} />}
      title="No goal selected"
      body="Open a goal to review its state, edit the contract, or run the team lead."
    />
  );
}

export function Goals({ selectedId = null, mode = null }) {
  const [goals, setGoals] = useState([]);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(null);
  const [teams, setTeams] = useState([]);
  const [projects, setProjects] = useState([]);
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState("active");
  const [loading, setLoading] = useState(true);
  const searchRef = useRef(null);
  const reloadRef = useRef(null);
  const catalogRef = useRef(null);

  const reload = useCallback(() => {
    reloadRef.current?.abort?.();
    const ctrl = new AbortController();
    reloadRef.current = ctrl;
    setLoading(true);
    api.listGoals({ include_archived: "true" }, { signal: ctrl.signal })
      .then((res) => {
        if (!ctrl.signal.aborted) setGoals(res.goals || []);
      })
      .catch((err) => {
        if (err?.name !== "AbortError") setGoals([]);
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
  }, []);

  const loadCatalog = useCallback(() => {
    catalogRef.current?.abort?.();
    const ctrl = new AbortController();
    catalogRef.current = ctrl;
    Promise.all([
      api.listTeams({ include_archived: "true" }, { signal: ctrl.signal }),
      api.listProjects({ include_archived: "true" }, { signal: ctrl.signal }),
    ]).then(([teamRes, projectRes]) => {
      if (ctrl.signal.aborted) return;
      setTeams(teamRes.teams || []);
      setProjects(projectRes.projects || []);
    }).catch((err) => {
      if (err?.name !== "AbortError") {
        setTeams([]);
        setProjects([]);
      }
    });
  }, []);

  const reloadSoon = useThrottledCallback(reload, 100);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { loadCatalog(); }, [loadCatalog]);
  useEffect(() => () => {
    reloadRef.current?.abort?.();
    catalogRef.current?.abort?.();
  }, []);
  useSSE("global", (evt) => {
    if (typeof evt?.type === "string" && (
      evt.type.startsWith("goal_")
      || evt.type.startsWith("team_goal_")
      || evt.type.startsWith("team_")
      || evt.type.startsWith("project_")
      || evt.type.startsWith("lead_cycle_")
    )) {
      reloadSoon();
    }
  });
  useAppResume(reloadSoon);
  useAppResume(loadCatalog);
  useGlobalShortcuts({
    "/": (event) => {
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select?.();
    },
  });

  const loadDetail = useCallback(() => {
    if (!selectedId || selectedId === "new") {
      setDetail(null);
      setDetailError(null);
      setDetailLoading(false);
      return;
    }
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    api.getGoal(selectedId)
      .then((res) => {
        const nextGoal = res.goal || null;
        setDetail(nextGoal);
        setDetailError(nextGoal ? null : "Goal not found.");
      })
      .catch((err) => {
        setDetail(null);
        setDetailError(err?.message || "Goal not found.");
      })
      .finally(() => setDetailLoading(false));
  }, [selectedId]);
  useEffect(() => { loadDetail(); }, [loadDetail]);

  const groups = useMemo(() => buildGoalResourceGroups(goals, { query, state: stateFilter }), [goals, query, stateFilter]);
  const filtered = groups.flatMap((group) => group.items);
  const hasFilter = query.trim() || stateFilter !== "active";
  const stateTabs = useMemo(() => [
    { value: "active", label: "Active", count: goals.filter((goal) => goalGroupKey(goal) === "active").length },
    { value: "blocked", label: "Blocked", count: goals.filter((goal) => goalGroupKey(goal) === "blocked").length },
    { value: "paused", label: "Paused", count: goals.filter((goal) => goalGroupKey(goal) === "paused").length },
    { value: "complete", label: "Complete", count: goals.filter((goal) => goalGroupKey(goal) === "complete").length },
    { value: "all", label: "All", count: goals.length },
  ], [goals]);

  const isNew = selectedId === "new";
  const isEditing = mode === "edit" || isNew;
  let body;
  if (isNew) {
    body = <GoalEditor isNew teams={teams} projects={projects} onSaved={() => { reload(); loadCatalog(); }} />;
  } else if (selectedId) {
    if (detailLoading) {
      body = <LoadingState caption="Loading goal..." />;
    } else if (!detail) {
      body = (
        <EmptyState
          icon={<Icon name="target" size={28} />}
          title="Goal not found"
          body={detailError || "This goal is unavailable or has been removed."}
          cta={<Button variant="secondary" onClick={() => navigateHash("#/goals")}>Back to goals</Button>}
        />
      );
    } else if (isEditing) {
      body = <GoalEditor goal={detail} teams={teams} projects={projects} onSaved={() => { reload(); loadDetail(); }} />;
    } else {
      body = <GoalDetail goal={detail} onChanged={() => { reload(); loadDetail(); }} />;
    }
  } else {
    body = emptyDetail();
  }

  return (
    <AppShell route="goals">
      <PaneLayout
        hasSelection={!!selectedId}
        onBack={() => navigateHash("#/goals")}
        backLabel="Goals"
        listHeader={(
          <ResourceListToolbar
            searchValue={query}
            onSearch={setQuery}
            searchPlaceholder="Search goals..."
            searchAriaLabel="Search goals"
            searchRef={searchRef}
            countLabel={loading ? "Loading" : `${filtered.length} shown`}
            actionLabel="New goal"
            onAction={() => navigateHash("#/goals/new")}
            actionIcon="target"
            configTitle="Goals configuration"
            activeConfigCount={[stateFilter !== "active"].filter(Boolean).length}
          >
            <Tabs value={stateFilter} onChange={setStateFilter} tabs={stateTabs} ariaLabel="Filter goals by state" class="tabs-pills" />
          </ResourceListToolbar>
        )}
        listBody={(
          <ResourceList class="goal-resource-list">
            {filtered.length === 0 ? (
              hasFilter ? (
                <EmptyStateFiltered body="No goals match." onClearFilters={() => { setQuery(""); setStateFilter("active"); }} />
              ) : (
                <EmptyState
                  icon={<Icon name="target" size={28} />}
                  title="No goals"
                  body="Create a team-project goal to give a lead cycle a durable objective."
                />
              )
            ) : groups.map((group) => (
              <ResourceGroup key={group.key} group={group}>
                {group.items.map((goal) => (
                  <GoalRow
                    key={goal.goal_id}
                    goal={goal}
                    active={goal.goal_id === selectedId || goal.id === selectedId}
                  />
                ))}
              </ResourceGroup>
            ))}
          </ResourceList>
        )}
        detail={body}
        listFirst
        class="resource-list-layout goals-layout"
      />
    </AppShell>
  );
}
