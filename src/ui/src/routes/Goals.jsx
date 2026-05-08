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
import { DetailHead } from "../components/layout/index.js";
import { Button } from "../components/primitives/Button.jsx";
import { Select } from "../components/primitives/Select.jsx";
import { Tabs } from "../components/primitives/Tabs.jsx";
import { Input } from "../components/primitives/Input.jsx";
import { Textarea } from "../components/primitives/Textarea.jsx";
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

function constraintsToText(value) {
  return Array.isArray(value) ? value.join("\n") : "";
}

function constraintsFromText(value) {
  return String(value || "")
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function goalDraftFrom(goal = {}) {
  const contract = goal?.contract || {};
  return {
    team_id: goal?.team_id || "",
    project_id: goal?.project_id || "",
    objective: contract.objective || "",
    stopping_condition: contract.stopping_condition || "",
    validation_loop: contract.validation_loop || "",
    constraints_text: constraintsToText(contract.constraints),
  };
}

function goalProjectLabel(goal = {}) {
  return goal.project?.name || goal.project?.slug || goal.project_id || "Untitled project";
}

function goalTeamLabel(goal = {}) {
  return goal.team_name || goal.team_slug || goal.team_id || "Unassigned team";
}

function GoalContractDetails({ goal }) {
  const contract = goal?.contract || {};
  const checkpoint = latestCheckpoint(goal);
  return (
    <div class="team-goal-contract">
      <div>
        <span>Objective</span>
        <strong>{contract.objective || "(not set)"}</strong>
      </div>
      <div>
        <span>Stop when</span>
        <strong>{contract.stopping_condition || "(not set)"}</strong>
      </div>
      <div>
        <span>Validate with</span>
        <strong>{contract.validation_loop || "(not set)"}</strong>
      </div>
      {contract.constraints?.length ? (
        <div>
          <span>Constraints</span>
          <strong>{contract.constraints.join(", ")}</strong>
        </div>
      ) : null}
      {checkpoint ? (
        <div>
          <span>Latest checkpoint</span>
          <strong>{checkpoint.checkpoint_note || checkpoint.validation_summary || "(empty checkpoint)"}</strong>
        </div>
      ) : null}
      {goal.goal_status_reason ? (
        <div>
          <span>Status reason</span>
          <strong>{goal.goal_status_reason}</strong>
        </div>
      ) : null}
    </div>
  );
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
            <ResourceRowChip>team {goalTeamLabel(goal)}</ResourceRowChip>
            {goal.last_lead_at && <ResourceRowChip>lead {relativeTime(goal.last_lead_at)}</ResourceRowChip>}
            {checkpoint && <ResourceRowChip>checkpoint</ResourceRowChip>}
          </ResourceRowTags>
        </span>
      )}
      trailing={<Badge variant={goalStatusVariant(goal)}>{goalStatusLabel(goal)}</Badge>}
    />
  );
}

function GoalDetail({ goal, onChanged }) {
  const [running, setRunning] = useState(false);
  const [updating, setUpdating] = useState(false);
  const paused = Boolean(goal?.contract?.paused_at);

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

  const latest = goal.latest_cycle || null;
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
        <div class="goal-detail-grid">
          <Card title="Goal state">
            <div class="goal-state-card">
              <Chip variant={goalStatusVariant(goal)}>{goalStatusLabel(goal)}</Chip>
              {goal.last_lead_at ? <span>Last lead cycle {relativeTime(goal.last_lead_at)}</span> : <span>No lead cycle yet.</span>}
            </div>
          </Card>
          <Card title="Contract">
            <GoalContractDetails goal={goal} />
          </Card>
          <Card title="Links">
            <div class="goal-link-list">
              <a href={`#/projects/${encodeURIComponent(goal.project?.slug || goal.project_id)}`}>Project</a>
              <a href={`#/teams/${encodeURIComponent(goal.team_slug || goal.team_id)}`}>Team</a>
              {goal.root_task_id && <a href={`#/tasks/${encodeURIComponent(goal.root_task_id)}`}>Root task</a>}
            </div>
          </Card>
          <Card title="Latest lead cycle">
            {latest ? (
              <div class="goal-latest-cycle">
                <Badge variant={latest.process_status === "failed" ? "warn" : "muted"}>{latest.process_status || latest.status || "unknown"}</Badge>
                {latest.summary ? <span>{latest.summary}</span> : <span>No summary.</span>}
                {latest.id && <a href={`#/tasks/${encodeURIComponent(latest.task_id)}?run=${encodeURIComponent(latest.id)}`}>Open run</a>}
              </div>
            ) : (
              <p class="muted">No lead-cycle runs yet.</p>
            )}
          </Card>
        </div>
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
    if (isNew && !draft.team_id) {
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
      team_id: draft.team_id || undefined,
      project_id: draft.project_id || undefined,
      objective: draft.objective,
      stopping_condition: draft.stopping_condition,
      validation_loop: draft.validation_loop,
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

  const teamOptions = teams.map((team) => ({
    value: team.id,
    label: team.name || team.slug || team.id,
    description: team.goal || team.description || team.slug,
  }));
  const projectOptions = projects.map((project) => ({
    value: project.id,
    label: project.name || project.slug || project.id,
    description: [
      project.slug,
      project.team_id ? `team ${project.team_id}` : "unassigned",
      project.archived ? "archived" : null,
    ].filter(Boolean).join(" · "),
    disabled: !!project.archived,
  }));

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
        <div class="goal-editor">
          {error && <p class="error">{error}</p>}
          <FormSection kicker="Assignment" title="Assignment">
            <FormGrid columns={2}>
              <FormField label="Team">
                <Select
                  value={draft.team_id}
                  onChange={(value) => update({ team_id: value })}
                  options={teamOptions}
                  placeholder="Choose team"
                  disabled={!isNew}
                  searchable
                />
              </FormField>
              <FormField label="Project">
                <Select
                  value={draft.project_id}
                  onChange={(value) => update({ project_id: value })}
                  options={projectOptions}
                  placeholder="Choose project"
                  disabled={!isNew}
                  searchable
                />
              </FormField>
            </FormGrid>
          </FormSection>
          <FormSection kicker="Contract" title="Contract">
            <FormGrid columns={2}>
              <FormField label="Objective" class="span-2">
                <Textarea rows={4} value={draft.objective} onInput={(event) => update({ objective: event.currentTarget.value })} />
              </FormField>
              <FormField label="Stop when">
                <Input value={draft.stopping_condition} onInput={(event) => update({ stopping_condition: event.currentTarget.value })} />
              </FormField>
              <FormField label="Validate with">
                <Input value={draft.validation_loop} onInput={(event) => update({ validation_loop: event.currentTarget.value })} />
              </FormField>
              <FormField label="Constraints" class="span-2">
                <Textarea rows={4} value={draft.constraints_text} onInput={(event) => update({ constraints_text: event.currentTarget.value })} />
              </FormField>
            </FormGrid>
          </FormSection>
        </div>
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
