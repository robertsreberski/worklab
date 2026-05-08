import { useEffect, useMemo, useState, useCallback, useRef } from "preact/hooks";
import { api } from "../lib/api.js";
import { navigateHash, proceedToHash, useUnsavedChangesGuard } from "../lib/navigation.js";
import { taskDisplayKey, taskRouteId } from "../lib/display.js";
import { buildProjectTaskProgress } from "../lib/projectTaskProgress.js";
import { buildKnowledgePromotionHash, groupProjectKnowledgeEntries, recentProjectTaskOutputs } from "../lib/projectKnowledge.js";
import { useSSE } from "../lib/useSSE.js";
import { useThrottledCallback } from "../lib/useThrottledCallback.js";
import { useAppResume } from "../lib/pageVisibility.js";
import { useGlobalShortcuts } from "../lib/useGlobalShortcuts.js";
import { AppShell, MobilePillRow, MobileTopbar } from "../components/AppShell.jsx";
import { EntityChromeBridge } from "../components/EntityChromeBridge.jsx";
import { PaneLayout } from "../components/PaneLayout.jsx";
import { PaneRow } from "../components/PaneRow.jsx";
import { DetailHead, InlineHead, SectionGroup, SectionMarker, SectionStack } from "../components/layout/index.js";
import { ResourceGroup, ResourceList, ResourceListToolbar } from "../components/ResourceListToolbar.jsx";
import { ResourceRowChip, ResourceRowId, ResourceRowPath, ResourceRowTags } from "../components/ResourceRowMeta.jsx";
import { Button } from "../components/primitives/Button.jsx";
import { Input } from "../components/primitives/Input.jsx";
import { Select } from "../components/primitives/Select.jsx";
import { Tabs } from "../components/primitives/Tabs.jsx";
import { Textarea } from "../components/primitives/Textarea.jsx";
import { Switch } from "../components/primitives/Switch.jsx";
import { Chip } from "../components/primitives/Chip.jsx";
import { TagInput } from "../components/primitives/SpecialInputs.jsx";
import { StatusPill } from "../components/primitives/StatusPill.jsx";
import { Card } from "../components/Card.jsx";
import { FormField } from "../components/FormField.jsx";
import { FormGrid } from "../components/FormGrid.jsx";
import { FormSection } from "../components/FormSection.jsx";
import { TeamPicker } from "../components/TeamPicker.jsx";
import { EntityMetaList } from "../components/EntityMetaList.jsx";
import { EmptyState, EmptyStateFiltered } from "../components/EmptyState.jsx";
import { LoadingState } from "../components/LoadingState.jsx";
import { Banner } from "../components/Banner.jsx";
import { MarkdownContent } from "../components/Markdown.jsx";
import { Icon } from "../components/Icon.jsx";
import { buildProjectResourceGroups, flattenResourceGroups } from "../lib/resourceLists.js";
import { pushToast } from "../lib/toast.js";

const PROJECT_SECTIONS = [
  { id: "project-details", num: "01", label: "Details", meta: "Context" },
  { id: "project-tasks", num: "02", label: "Tasks", meta: "Membership" },
  { id: "project-knowledge", num: "03", label: "Knowledge", meta: "Linked" },
];

const PROJECT_EDIT_SECTIONS = [
  { id: "project-edit-details", num: "01", label: "Details", meta: "Metadata" },
  { id: "project-edit-context", num: "02", label: "Context", meta: "Markdown" },
  { id: "project-edit-team", num: "03", label: "Team", meta: "Roster" },
];

const WORKTREE_MODE_OPTIONS = [
  { value: "off", label: "Off", description: "Run directly in the project workdir." },
  { value: "auto", label: "Auto", description: "Use an isolated Git worktree when the project supports it." },
  { value: "required", label: "Required", description: "Block execute runs unless an isolated Git worktree is available." },
];

function projectRouteId(project) {
  return encodeURIComponent(project?.slug || project?.id || "");
}

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
function slugLooksValid(value) {
  if (!value) return true;
  return SLUG_PATTERN.test(value);
}

function projectDraftFrom(project = {}) {
  return {
    name: project.name || "",
    slug: project.slug || "",
    description: project.description || "",
    context: project.context || "",
    workdir: project.workdir || "",
    worktree_mode: project.worktree_mode || "off",
    tags: project.tags || [],
    team_id: project.team_id || null,
    archived: !!project.archived,
  };
}

function worktreeModeLabel(value) {
  return WORKTREE_MODE_OPTIONS.find((option) => option.value === value)?.label || "Off";
}

function projectTeamLabel(project) {
  return project?.team?.name || project?.team_name || project?.team_slug || project?.team_id || "";
}

function projectGoalStatusLabel(goal = {}) {
  if (goal?.contract?.paused_at) return "Paused";
  const status = goal?.goal_status || "in_progress";
  if (status === "complete") return "Complete";
  if (status === "blocked") return "Blocked";
  return "In progress";
}

function projectGoalChipVariant(goal = {}) {
  if (goal?.contract?.paused_at) return "muted";
  if (goal?.goal_status === "blocked") return "warn";
  if (goal?.goal_status === "complete") return "trigger";
  return "accent";
}

function latestProjectGoalCheckpoint(goal = {}) {
  const notes = Array.isArray(goal?.contract?.checkpoint_notes) ? goal.contract.checkpoint_notes : [];
  return notes[notes.length - 1] || null;
}

function formatProjectAge(value) {
  if (!value) return "";
  const ms = Date.now() - Number(value);
  if (ms < 60_000) return "now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  if (ms < 86_400_000 * 7) return `${Math.floor(ms / 86_400_000)}d`;
  return new Date(Number(value)).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function ProjectGoalSummary({ goal }) {
  if (!goal) return null;
  const contract = goal.contract || {};
  const checkpoint = latestProjectGoalCheckpoint(goal);
  return (
    <div class="project-goal-summary">
      <InlineHead class="project-goal-summary-head">
        <div>
          <span class="soft-meta">Project goal</span>
          <strong>{goal.team_name || goal.team_slug || "Assigned team"}</strong>
        </div>
        <Chip variant={projectGoalChipVariant(goal)}>{projectGoalStatusLabel(goal)}</Chip>
      </InlineHead>
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
        {checkpoint ? (
          <div>
            <span>Latest checkpoint</span>
            <strong>{checkpoint.checkpoint_note || checkpoint.validation_summary || "(empty checkpoint)"}</strong>
          </div>
        ) : null}
      </div>
      <div class="project-goal-links">
        {goal.goal_id || goal.root_task_id ? (
          <a href={`#/goals/${encodeURIComponent(goal.goal_id || goal.root_task_id)}`}>Goal</a>
        ) : null}
        {goal.team_slug || goal.team_id ? (
          <a href={`#/teams/${encodeURIComponent(goal.team_slug || goal.team_id)}`}>Team</a>
        ) : null}
        {goal.root_task_id ? (
          <a href={`#/tasks/${encodeURIComponent(goal.root_task_id)}`}>Root task</a>
        ) : null}
      </div>
    </div>
  );
}

function ProjectTaskAttentionChips({ items = [], limit = 3 }) {
  const visible = items.slice(0, limit);
  const extra = items.length - visible.length;
  if (!visible.length) return null;
  return (
    <span class="project-task-attention-chips">
      {visible.map((item) => (
        <span
          key={item.key}
          class={`project-task-attention-chip is-${item.tone || "warn"}`}
          title={item.title || item.label}
        >
          {item.tone === "error" && <Icon name="alert-triangle" size={10} />}
          {item.label}
        </span>
      ))}
      {extra > 0 && <span class="project-task-attention-chip is-muted">+{extra}</span>}
    </span>
  );
}

function formatChildTaskSummary(task) {
  const childCount = Number(task.child_count || 0);
  if (!childCount) return null;
  const done = Number(task.child_counts?.done || 0);
  const active = Number(task.child_counts?.in_progress || 0);
  const parts = [`${done}/${childCount} child${childCount === 1 ? "" : "ren"} done`];
  if (active > 0) parts.push(`${active} active`);
  return parts.join(" / ");
}

function ProjectTaskRow({ task, nested = false }) {
  const displayStage = task.running_run_id ? "running" : (task.stage || "plan");
  const reason = task.stage_reason || task.error_text || task.last_run?.summary || "";
  const children = nested ? [] : (Array.isArray(task.child_tasks) ? task.child_tasks : []);
  const childSummary = formatChildTaskSummary(task);
  const row = (
    <a class={`project-task-row${nested ? " is-child" : ""}`} href={`#/tasks/${taskRouteId(task)}`}>
      <span class="project-task-row-key pane-row-mono">{taskDisplayKey(task)}</span>
      <span class="project-task-row-main">
        <span class="project-task-row-title">{task.title}</span>
        <span class="project-task-row-meta">
          <StatusPill status={displayStage} size="sm" />
          {nested && <span>Child task</span>}
          {task.owner_agent && <span>{task.owner_agent}</span>}
          {reason && <span class="truncate">{reason}</span>}
          {childSummary && <span class="truncate">{childSummary}</span>}
        </span>
      </span>
      <ProjectTaskAttentionChips items={task.attention || []} />
      <span class="project-task-row-age">{formatProjectAge(task.updated_at)}</span>
    </a>
  );

  if (!children.length) return row;

  return (
    <div class="project-task-row-block">
      {row}
      <div class="project-task-child-list" aria-label={`Child tasks for ${task.title}`}>
        {children.map((child) => <ProjectTaskRow key={child.id} task={child} nested />)}
      </div>
    </div>
  );
}

function ProjectTaskProgress({ tasks = [], progress: providedProgress = null }) {
  const computedProgress = useMemo(() => buildProjectTaskProgress(tasks), [tasks]);
  const progress = providedProgress || computedProgress;
  const total = progress.total;
  const attentionCount = progress.attention_tasks.length;
  const childTotal = Number(progress.child_total || 0);
  const nestedChildTotal = Number(progress.nested_child_total || 0);
  return (
    <div class="project-task-progress">
      <InlineHead class="project-task-progress-head">
        <div class="project-task-progress-copy">
          <strong>{progress.percent_done}%</strong>
          <span>complete across {total} top-level task{total === 1 ? "" : "s"}</span>
        </div>
        <div class="project-task-progress-counts" aria-label="Project task counts">
          {progress.groups.map((group) => (
            <span key={group.key} data-group={group.key}>
              <span class="project-task-count-dot" aria-hidden="true" />
              {group.label}: {progress.counts[group.key] || 0}
            </span>
          ))}
          {childTotal > 0 && (
            <span data-group="children">
              <span class="project-task-count-dot" aria-hidden="true" />
              Children: {childTotal}
            </span>
          )}
        </div>
      </InlineHead>
      {nestedChildTotal > 0 && (
        <div class="field-hint">
          {nestedChildTotal} delegated child task{nestedChildTotal === 1 ? "" : "s"} nested under parent tasks.
        </div>
      )}

      <div class="project-task-progress-bar" role="img" aria-label={`${progress.percent_done}% complete across ${total} top-level project tasks`}>
        {total > 0 ? progress.groups.map((group) => {
          const count = progress.counts[group.key] || 0;
          if (count === 0) return null;
          return (
            <span
              key={group.key}
              class={`project-task-progress-segment is-${group.key}`}
              style={{ width: `${(count / total) * 100}%` }}
              title={`${group.label}: ${count}`}
            />
          );
        }) : <span class="project-task-progress-segment is-empty" />}
      </div>

      {attentionCount > 0 && (
        <div class="project-task-attention-panel" role="status">
          <InlineHead class="project-task-attention-head">
            <Icon name="alert-triangle" size={14} />
            <strong>{attentionCount} requiring attention</strong>
          </InlineHead>
          <div class="project-task-attention-list">
            {progress.attention_tasks.slice(0, 4).map((task) => (
              <a key={task.id} href={`#/tasks/${taskRouteId(task)}`} class="project-task-attention-item">
                <span class="pane-row-mono">{taskDisplayKey(task)}</span>
                <span class="truncate">{task.title}</span>
                <ProjectTaskAttentionChips items={task.attention || []} limit={1} />
              </a>
            ))}
            {attentionCount > 4 && <span class="project-task-attention-more">+{attentionCount - 4} more</span>}
          </div>
        </div>
      )}

      <SectionStack class="project-task-groups">
        {progress.groups.map((group) => (
          <SectionGroup
            key={group.key}
            class="project-task-group"
            data-group={group.key}
            label={group.label}
            count={group.tasks.length}
          >
            {group.tasks.length ? (
              <div class="project-task-group-list">
                {group.tasks.map((task) => <ProjectTaskRow key={task.id} task={task} />)}
              </div>
            ) : (
              <div class="project-task-group-empty">No {group.label.toLowerCase()} tasks.</div>
            )}
          </SectionGroup>
        ))}
      </SectionStack>
    </div>
  );
}

function ProjectEditor({ selectedId, onSaved }) {
  const isNew = selectedId === "new";
  const [draft, setDraft] = useState(projectDraftFrom());
  const [baseline, setBaseline] = useState(projectDraftFrom());
  const [loading, setLoading] = useState(!isNew);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [teams, setTeams] = useState([]);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    if (isNew) {
      const empty = projectDraftFrom();
      setDraft(empty);
      setBaseline(empty);
      setLoading(false);
      return () => controller.abort();
    }
    setLoading(true);
    api.getProject(selectedId, { signal: controller.signal })
      .then((res) => {
        if (controller.signal.aborted) return;
        const next = projectDraftFrom(res.project);
        setDraft(next);
        setBaseline(next);
      })
      .catch((err) => { if (err?.name !== "AbortError") setError(err.message || "Project not found"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [isNew, selectedId]);

  useEffect(() => {
    const controller = new AbortController();
    api.listTeams({ include_archived: "true" }, { signal: controller.signal })
      .then((res) => { if (!controller.signal.aborted) setTeams(res.teams || []); })
      .catch((err) => { if (err?.name !== "AbortError") setTeams([]); });
    return () => controller.abort();
  }, []);

  const isDirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(baseline), [draft, baseline]);
  useAppResume(() => {
    api.listTeams({ include_archived: "true" }).then((res) => setTeams(res.teams || [])).catch(() => setTeams([]));
    if (isNew || isDirty) return;
    api.getProject(selectedId)
      .then((res) => {
        const next = projectDraftFrom(res.project);
        setDraft(next);
        setBaseline(next);
        setError(null);
      })
      .catch((err) => setError(err.message || "Project not found"));
  });

  const slugTrimmed = draft.slug.trim();
  const slugValid = slugLooksValid(slugTrimmed);
  const canSave = !!draft.name.trim() && slugValid;

  function update(patch) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  async function save({ navigateOnSuccess = true } = {}) {
    if (!draft.name.trim()) {
      pushToast("Project name is required", { variant: "error" });
      throw new Error("Project name is required");
    }
    setSaving(true);
    try {
      const payload = {
        name: draft.name.trim(),
        slug: draft.slug.trim() || undefined,
        description: draft.description,
        context: draft.context,
        workdir: draft.workdir.trim() || null,
        worktree_mode: draft.worktree_mode || "off",
        tags: draft.tags || [],
        team_id: draft.team_id || null,
        archived: !!draft.archived,
      };
      const res = isNew
        ? await api.createProject(payload)
        : await api.patchProject(selectedId, payload);
      const saved = projectDraftFrom(res.project);
      setDraft(saved);
      setBaseline(saved);
      onSaved?.();
      pushToast(isNew ? "Project created" : "Project saved", { variant: "success" });
      if (navigateOnSuccess) proceedToHash(`#/projects/${projectRouteId(res.project)}`);
      return res.project;
    } catch (err) {
      setError(err.message || "Save failed");
      throw err;
    } finally {
      setSaving(false);
    }
  }

  const guard = useUnsavedChangesGuard({ isDirty, onSave: () => save({ navigateOnSuccess: false }) });
  const cancel = () => guard.requestNavigation(isNew ? "#/projects" : `#/projects/${encodeURIComponent(selectedId)}`);

  useGlobalShortcuts({
    cmds: (event) => { event.preventDefault(); save().catch(() => {}); },
    Escape: () => cancel(),
  });

  const chrome = {
    mobileTopbar: <MobileTopbar title={isNew ? "New project" : draft.slug || selectedId} backLabel="Projects" onBack={cancel} />,
    mobileActionDock: (
      <>
        <Button variant="secondary" onClick={cancel}>Cancel</Button>
        <Button variant={isDirty || isNew ? "primary" : "secondary"} loading={saving} disabled={!canSave} onClick={() => save().catch(() => {})}>
          {isNew ? "Create" : "Save"}
        </Button>
      </>
    ),
    drawerTitle: "Details",
    drawerKicker: isNew ? "New" : draft.slug,
    drawerContent: (
      <div class="entity-editor-rail-content">
        <Card variant="spacious" title="Project" class="entity-rail-card">
          <EntityMetaList items={[
            { label: "Slug", value: isNew ? "Generated on create" : draft.slug },
            { label: "Workdir", value: draft.workdir || "Default workspace", mono: false },
            { label: "Worktrees", value: worktreeModeLabel(draft.worktree_mode), mono: false },
            { label: "Tags", value: `${(draft.tags || []).length}`, mono: false },
            { label: "Team", value: draft.team_id ? draft.team_id : "(none)", mono: false },
            { label: "Archived", value: draft.archived ? "Yes" : "No", mono: false },
          ]} />
        </Card>
      </div>
    ),
    sections: PROJECT_EDIT_SECTIONS,
  };

  if (loading) return <LoadingState caption="Loading project..." />;

  return (
    <>
      <EntityChromeBridge chrome={chrome} />
      <DetailHead
        class="project-detail-head"
        crumbs={[{ label: "Projects", href: "#/projects" }, { label: isNew ? "New" : draft.slug || selectedId }]}
        icon={<Icon name="folder" size={16} />}
        kicker={isNew ? "Create project" : "Project editor"}
        title={draft.name || "Untitled project"}
        meta={<span class="pane-row-mono">{isNew ? "New project" : draft.slug}</span>}
        actions={(
          <>
            <Button variant="ghost" onClick={cancel}>Cancel</Button>
            <Button variant={isDirty || isNew ? "primary" : "secondary"} loading={saving} disabled={!canSave} onClick={() => save().catch(() => {})}>
              {isNew ? "Create" : "Save"}
            </Button>
          </>
        )}
        subBar={<MobilePillRow railLabel="Details" railCount={1} sections={PROJECT_EDIT_SECTIONS} />}
      />
      <div class="pane-detail-body entity-detail-body project-detail-body">
        {error && <Banner variant="error" title="Project save failed" detail={error} />}
        <div class="entity-editor-layout project-editor-layout">
          <main class="entity-editor-main">
            <SectionMarker id="project-edit-details" num="01" kicker="Details" meta="Metadata" />
            <FormSection kicker="Metadata" title="Project details">
              <FormGrid columns={2}>
                <FormField label="Name" required>
                  <Input value={draft.name} onInput={(event) => update({ name: event.currentTarget.value })} placeholder="Project name" autoFocus={isNew} />
                </FormField>
                <FormField
                  label="Slug"
                  hint={slugValid ? "Lowercase letters, digits, and hyphens." : null}
                  error={slugValid ? null : "Slug must use lowercase letters, digits, and hyphens (no leading/trailing dash)."}
                >
                  <Input
                    value={draft.slug}
                    onInput={(event) => update({ slug: event.currentTarget.value })}
                    placeholder="generated-from-name"
                    aria-invalid={!slugValid}
                  />
                </FormField>
                <FormField label="Description">
                  <Input value={draft.description} onInput={(event) => update({ description: event.currentTarget.value })} placeholder="Short summary" />
                </FormField>
                <FormField label="Workdir" hint="Optional. Overrides the default workspace for assigned task runs.">
                  <Input value={draft.workdir} onInput={(event) => update({ workdir: event.currentTarget.value })} placeholder="/path/to/project" />
                </FormField>
                <FormField label="Worktrees" hint="Execute runs use the source checkout as truth and merge back only after success.">
                  <Select
                    variant="native"
                    value={draft.worktree_mode || "off"}
                    options={WORKTREE_MODE_OPTIONS}
                    onChange={(worktreeMode) => update({ worktree_mode: worktreeMode })}
                    ariaLabel="Project worktree mode"
                  />
                </FormField>
                <FormField label="Tags">
                  <TagInput value={draft.tags || []} onChange={(tags) => update({ tags })} placeholder="Add tag..." />
                </FormField>
                <FormField switchInside>
                  <Switch
                    checked={draft.archived}
                    onChange={(archived) => update({ archived })}
                    label="Archived"
                    description="Hide from default project lists without removing task links."
                  />
                </FormField>
              </FormGrid>
            </FormSection>

            <SectionMarker id="project-edit-context" num="02" kicker="Context" meta="Markdown" />
            <FormSection kicker="Run context" title="Context inserted into assigned task runs">
              <Textarea rows={18} monospace autoGrow value={draft.context} onInput={(event) => update({ context: event.currentTarget.value })} />
            </FormSection>

            <SectionMarker id="project-edit-team" num="03" kicker="Team" meta="Roster" />
            <FormSection
              kicker="Team"
              title="Assigned team"
              description="Tasks in this project use the team's roster (lead + members) for delegation, and team budgets cap their cumulative spend. Manage rosters from the Teams page."
            >
              <FormGrid columns={1}>
                <FormField label="Team" hint="Leave blank to remove the team assignment.">
                  <TeamPicker
                    value={draft.team_id || ""}
                    onChange={(teamId) => update({ team_id: teamId })}
                    teams={teams}
                    clearLabel="No team"
                    placeholder="Pick a team"
                    ariaLabel="Project team"
                  />
                </FormField>
              </FormGrid>
            </FormSection>
          </main>
        </div>
      </div>
    </>
  );
}

function ProjectDetail({ selectedId, onChanged }) {
  const [project, setProject] = useState(null);
  const [knowledgeEntries, setKnowledgeEntries] = useState([]);
  const [error, setError] = useState(null);
  const reloadAbortRef = useRef(null);

  const reload = useCallback(() => {
    reloadAbortRef.current?.abort?.();
    const controller = new AbortController();
    reloadAbortRef.current = controller;
    setProject(null);
    setKnowledgeEntries([]);
    setError(null);
    return Promise.all([
      api.getProject(selectedId, { signal: controller.signal }),
      api.listKb({ project_id: selectedId }, { signal: controller.signal }).catch(() => ({ entries: [] })),
    ])
      .then(([projectRes, kbRes]) => {
        if (!controller.signal.aborted) {
          setProject(projectRes.project);
          setKnowledgeEntries(kbRes.entries || []);
        }
      })
      .catch((err) => { if (err?.name !== "AbortError") setError(err.message || "Project not found"); });
  }, [selectedId]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => () => reloadAbortRef.current?.abort?.(), []);
  useAppResume(reload);

  const rail = useMemo(() => {
    if (!project) return null;
    return (
      <div class="entity-editor-rail-content project-read-rail-content">
        <Card variant="spacious" title="Project" class="entity-rail-card">
          <EntityMetaList items={[
            { label: "Slug", value: project.slug },
            { label: "Workdir", value: project.workdir || "Default workspace", mono: false },
            { label: "Worktrees", value: worktreeModeLabel(project.worktree_mode), mono: false },
            project.repository_instructions?.recognized
              ? { label: "Repository instructions", value: `${project.repository_instructions.filename} recognized`, mono: false }
              : null,
            { label: "Tasks", value: String(project.stats?.task_count || 0), mono: false },
            { label: "Tags", value: project.tags?.length ? project.tags.join(", ") : "None", mono: false },
            { label: "Team", value: project.team_id || "(none)", mono: false },
            { label: "Updated", value: formatProjectAge(project.updated_at), mono: false },
            { label: "Archived", value: project.archived ? "Yes" : "No", mono: false },
          ]} />
        </Card>
      </div>
    );
  }, [project]);
  const taskProgress = useMemo(() => buildProjectTaskProgress(project?.tasks || []), [project?.tasks]);
  const knowledgeGroups = useMemo(() => groupProjectKnowledgeEntries(knowledgeEntries), [knowledgeEntries]);
  const taskOutputs = useMemo(() => recentProjectTaskOutputs(project?.tasks || []), [project?.tasks]);
  const canonicalKnowledgeCount = knowledgeGroups.reduce((sum, group) => sum + group.entries.length, 0);
  const taskSectionMeta = taskProgress.child_total > 0
    ? `${taskProgress.total} top-level + ${taskProgress.child_total} child${taskProgress.child_total === 1 ? "" : "ren"}`
    : `${taskProgress.total} linked`;
  const knowledgeSectionMeta = `${canonicalKnowledgeCount} canonical · ${taskOutputs.length} output${taskOutputs.length === 1 ? "" : "s"}`;

  if (error) {
    return (
      <div class="pane-empty">
        <Icon name="folder" size={28} />
        <h3>Project not found</h3>
        <p>{error}</p>
      </div>
    );
  }
  if (!project) return <LoadingState caption="Loading project..." />;

  async function archiveProject() {
    try {
      await api.archiveProject(project.id);
      pushToast("Project archived", { variant: "success" });
      onChanged?.();
      navigateHash("#/projects");
    } catch (err) {
      pushToast(`Archive failed: ${err.message}`, { variant: "error" });
    }
  }

  return (
    <>
      <EntityChromeBridge
        chrome={{
          mobileTopbar: <MobileTopbar title={project.slug} backLabel="Projects" onBack={() => navigateHash("#/projects")} />,
          mobileActionDock: (
            <>
              <Button variant="primary" iconLeft={<Icon name="edit-3" size={13} />} onClick={() => navigateHash(`#/projects/${projectRouteId(project)}/edit`)}>
                Edit
              </Button>
              {!project.archived && (
                <Button variant="secondary" iconLeft={<Icon name="minus-circle" size={13} />} onClick={archiveProject}>
                  Archive
                </Button>
              )}
            </>
          ),
          drawerTitle: "Details",
          drawerKicker: project.slug,
          drawerContent: rail,
          sections: PROJECT_SECTIONS,
        }}
      />
      <DetailHead
        class="project-detail-head project-read-head"
        crumbs={[{ label: "Projects", href: "#/projects" }, { label: project.name }]}
        icon={<Icon name="folder" size={16} />}
        kicker="Project"
        title={project.name}
        meta={(
          <>
            <span class="pane-row-mono">{project.slug}</span>
            <span class="pane-row-dot">·</span>
            <span>{project.stats?.task_count || 0} task{project.stats?.task_count === 1 ? "" : "s"}</span>
            {project.archived && (
              <>
                <span class="pane-row-dot">·</span>
                <span>Archived</span>
              </>
            )}
          </>
        )}
        actions={(
          <>
            {project.archived && <Chip variant="muted">Archived</Chip>}
            <Button variant="secondary" iconLeft={<Icon name="edit-3" size={13} />} onClick={() => navigateHash(`#/projects/${projectRouteId(project)}/edit`)}>
              Edit
            </Button>
            {!project.archived && (
              <Button variant="secondary" iconLeft={<Icon name="minus-circle" size={13} />} onClick={archiveProject}>
                Archive
              </Button>
            )}
          </>
        )}
        subBar={<MobilePillRow railLabel="Details" railCount={1} sections={PROJECT_SECTIONS} />}
      />
      <div class="pane-detail-body entity-detail-body project-detail-body">
        <div class="knowledge-read-layout project-read-layout">
          <main class="knowledge-read-main project-read-main">
            <FormSection class="knowledge-read-section" aria-labelledby="project-details">
              <SectionMarker id="project-details" num="01" kicker="Context" meta="Run input" />
              {project.description && <p class="soft-meta project-description">{project.description}</p>}
              <div class="project-workdir-row">
                <span class="project-workdir-label">Workdir</span>
                <span class="project-workdir-value mono">{project.workdir || "Default workspace"}</span>
                {project.workdir && (
                  <Button
                    variant="ghost"
                    class="project-workdir-copy"
                    iconLeft={<Icon name="copy" size={11} />}
                    aria-label="Copy workdir"
                    title="Copy workdir"
                    onClick={() => {
                      navigator.clipboard?.writeText(project.workdir).then(
                        () => pushToast("Workdir copied", { variant: "success" }),
                        () => pushToast("Copy failed", { variant: "error" }),
                      );
                    }}
                  >
                    Copy
                  </Button>
                )}
              </div>
              <div class="project-workdir-row">
                <span class="project-workdir-label">Worktrees</span>
                <span class="project-workdir-value">{worktreeModeLabel(project.worktree_mode)}</span>
              </div>
              {project.repository_instructions?.recognized && (
                <div class="project-repository-status" title={project.repository_instructions.path || undefined}>
                  <Chip variant="trigger" leading={<Icon name="file-text" size={10} />}>
                    {project.repository_instructions.filename} recognized
                  </Chip>
                  <span>
                    Injected into task run prompts as {project.repository_instructions.prompt_section || "Repository instructions"}.
                  </span>
                </div>
              )}
              <ProjectGoalSummary goal={project.team_goal} />
              {project.context?.trim() ? (
                <article class="knowledge-read-article">
                  <MarkdownContent content={project.context} className="markdown doc-content knowledge-read-markdown" expandable={false} />
                </article>
              ) : (
                <div class="task-plan-empty">No project context yet.</div>
              )}
            </FormSection>

            <FormSection class="knowledge-read-section" aria-labelledby="project-tasks">
              <SectionMarker id="project-tasks" num="02" kicker="Tasks" meta={taskSectionMeta} />
              {project.tasks?.length ? (
                <ProjectTaskProgress tasks={project.tasks} progress={taskProgress} />
              ) : (
                <div class="task-plan-empty">No tasks are assigned to this project.</div>
              )}
            </FormSection>

            <FormSection class="knowledge-read-section" aria-labelledby="project-knowledge">
              <SectionMarker id="project-knowledge" num="03" kicker="Knowledge" meta={knowledgeSectionMeta} />
              {canonicalKnowledgeCount || taskOutputs.length ? (
                <div class="project-knowledge-workspace">
                  {canonicalKnowledgeCount > 0 && (
                    <SectionStack class="project-knowledge-groups">
                      {knowledgeGroups.map((group) => (
                        <SectionGroup
                          key={group.key}
                          class="project-knowledge-group"
                          label={group.label}
                          count={group.entries.length}
                        >
                          <div class="project-knowledge-list">
                            {group.entries.map((entry) => (
                              <a key={entry.slug} href={`#/knowledge/${encodeURIComponent(entry.slug)}`} class="project-knowledge-row">
                                <span class="project-knowledge-title">{entry.title || entry.slug}</span>
                                <span class="project-knowledge-meta">
                                  {entry.subcategory || entry.category || "uncategorized"}
                                  {entry.related_slugs?.length ? ` · ${entry.related_slugs.length} related` : ""}
                                  {entry.supersedes_slugs?.length ? ` · supersedes ${entry.supersedes_slugs.length}` : ""}
                                </span>
                              </a>
                            ))}
                          </div>
                        </SectionGroup>
                      ))}
                    </SectionStack>
                  )}

                  {taskOutputs.length > 0 && (
                    <SectionGroup
                      class="project-task-output-lane"
                      label="Recent task outputs"
                      count={taskOutputs.length}
                    >
                      <div class="project-output-list">
                        {taskOutputs.map((output) => (
                          <div key={`${output.task_id}:${output.run_id}`} class="project-output-row">
                            <a class="project-output-copy" href={`#/tasks/${taskRouteId({ id: output.task_id, task_key: output.task_key })}`}>
                              <span class="project-output-title">{output.title}</span>
                              <span class="project-output-meta">
                                {output.task_key || output.task_id}
                                {output.agent_name ? ` · ${output.agent_name}` : ""}
                                {output.artifact_label ? ` · ${output.artifact_label}` : ""}
                              </span>
                              {output.summary && <span class="project-output-summary">{output.summary}</span>}
                            </a>
                            <Button
                              size="sm"
                              variant="secondary"
                              iconLeft={<Icon name="upload" size={12} />}
                              onClick={() => navigateHash(buildKnowledgePromotionHash({ project, taskOutput: output }))}
                            >
                              Promote
                            </Button>
                          </div>
                        ))}
                      </div>
                    </SectionGroup>
                  )}
                </div>
              ) : (
                <div class="task-plan-empty">No canonical knowledge or task outputs yet.</div>
              )}
            </FormSection>
          </main>
          <aside class="entity-editor-rail project-read-rail is-mobile-drawer-source">{rail}</aside>
        </div>
      </div>
    </>
  );
}

export function Projects({ selectedId = null, mode = null }) {
  const [projects, setProjects] = useState([]);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("active");
  const [worktreeFilter, setWorktreeFilter] = useState("all");
  const [teamFilter, setTeamFilter] = useState("all");
  const searchRef = useRef(null);
  const reloadAbortRef = useRef(null);

  const reload = useCallback(() => {
    reloadAbortRef.current?.abort?.();
    const controller = new AbortController();
    reloadAbortRef.current = controller;
    api.listProjects({ include_archived: "true" }, { signal: controller.signal })
      .then((res) => { if (!controller.signal.aborted) setProjects(res.projects || []); })
      .catch((err) => { if (err?.name !== "AbortError") setProjects([]); });
  }, []);
  const reloadSoon = useThrottledCallback(reload, 100);
  const reloadEventually = useThrottledCallback(reload, 1500);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => () => reloadAbortRef.current?.abort?.(), []);
  useSSE("global", (evt) => {
    if (evt.type?.startsWith("project_")) reloadSoon();
    else if (evt.type?.startsWith("task_")) reloadEventually();
  });
  useAppResume(reloadSoon);
  useGlobalShortcuts({
    "/": (event) => {
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select?.();
    },
  });

  const groups = useMemo(() => buildProjectResourceGroups(projects, {
    query,
    status: statusFilter,
    worktree: worktreeFilter,
    team: teamFilter,
  }), [projects, query, statusFilter, teamFilter, worktreeFilter]);
  const filtered = useMemo(() => flattenResourceGroups(groups), [groups]);
  const hasFilter = query.trim() || statusFilter !== "active" || worktreeFilter !== "all" || teamFilter !== "all";
  const statusTabs = useMemo(() => [
    { value: "active", label: "Active", count: projects.filter((project) => !project.archived).length },
    { value: "archived", label: "Archived", count: projects.filter((project) => project.archived).length },
    { value: "all", label: "All", count: projects.length },
  ], [projects]);
  const worktreeOptions = useMemo(() => [
    { value: "all", label: "All worktrees" },
    ...WORKTREE_MODE_OPTIONS.map((option) => ({ value: option.value, label: option.label, description: option.description })),
  ], []);
  const teamOptions = useMemo(() => {
    const teams = new Map();
    for (const project of projects) {
      if (project.team_id) teams.set(project.team_id, projectTeamLabel(project) || project.team_id);
    }
    return [
      { value: "all", label: "All teams" },
      { value: "no_team", label: "No team" },
      ...[...teams.entries()]
        .sort((left, right) => left[1].localeCompare(right[1], undefined, { sensitivity: "base" }))
        .map(([value, label]) => ({ value, label })),
    ];
  }, [projects]);
  const resetFilters = () => {
    setQuery("");
    setStatusFilter("active");
    setWorktreeFilter("all");
    setTeamFilter("all");
  };

  const listHeader = (
    <ResourceListToolbar
      searchValue={query}
      onSearch={setQuery}
      searchPlaceholder="Search projects…"
      searchAriaLabel="Search projects"
      searchRef={searchRef}
      countLabel={`${filtered.length} shown`}
      actionLabel="New project"
      onAction={() => navigateHash("#/projects/new")}
      configTitle="Projects configuration"
      activeConfigCount={[statusFilter !== "active", worktreeFilter !== "all", teamFilter !== "all"].filter(Boolean).length}
    >
      <Tabs value={statusFilter} onChange={setStatusFilter} tabs={statusTabs} ariaLabel="Filter projects by archive state" class="tabs-pills" />
      <Select class="resource-filter-select" variant="menu" value={worktreeFilter} onChange={setWorktreeFilter} options={worktreeOptions} ariaLabel="Filter projects by worktree mode" />
      <Select class="resource-filter-select" variant="menu" value={teamFilter} onChange={setTeamFilter} options={teamOptions} ariaLabel="Filter projects by team" />
    </ResourceListToolbar>
  );

  const listBody = filtered.length === 0 ? (
    hasFilter ? (
      <EmptyStateFiltered body="No projects match." onClearFilters={resetFilters} />
    ) : (
      <EmptyState
        icon={<Icon name="folder" size={48} />}
        title="No projects yet"
        body="Create a project to share context and a workdir across related tasks."
        cta={<Button variant="primary" iconLeft={<Icon name="plus" size={13} />} onClick={() => navigateHash("#/projects/new")}>New project</Button>}
      />
    )
  ) : (
    <ResourceList>
      {groups.map((group) => (
        <ResourceGroup key={group.key} group={group}>
          {group.items.map((project) => {
            const teamLabel = projectTeamLabel(project);
            const taskCount = project.task_count ?? project.stats?.task_count ?? 0;
            const activeTaskCount = project.active_task_count ?? project.stats?.active_task_count ?? 0;
            const tags = Array.isArray(project.tags) ? project.tags : [];
            return (
              <PaneRow
                key={project.id || project.slug}
                href={`#/projects/${projectRouteId(project)}`}
                active={project.slug === selectedId || project.id === selectedId}
                class="project-pane-row"
                onClick={(event) => {
                  event?.preventDefault?.();
                  navigateHash(`#/projects/${projectRouteId(project)}`);
                }}
                leading={<span class="project-row-leading"><Icon name="folder" size={12} /></span>}
                title={project.name}
                sub={(
                  <span class="pane-row-substack">
                    {project.description && <span class="pane-row-description">{project.description}</span>}
                    <ResourceRowTags>
                      <ResourceRowId>{project.slug}</ResourceRowId>
                      <ResourceRowPath label="workdir" value={project.workdir} />
                      {project.worktree_mode && project.worktree_mode !== "off" && (
                        <ResourceRowChip>worktrees {project.worktree_mode}</ResourceRowChip>
                      )}
                      {teamLabel && <ResourceRowChip>team {teamLabel}</ResourceRowChip>}
                      {tags.slice(0, 3).map((tag) => <ResourceRowChip key={tag}>{tag}</ResourceRowChip>)}
                      {tags.length > 3 && <ResourceRowChip>+{tags.length - 3}</ResourceRowChip>}
                      {project.archived && <ResourceRowChip>archived</ResourceRowChip>}
                    </ResourceRowTags>
                  </span>
                )}
                trailing={(
                  <span class="pane-row-summary pane-row-summary-metrics">
                    <span title={`${activeTaskCount} active of ${taskCount} total`}>
                      {activeTaskCount}/{taskCount} task{taskCount === 1 ? "" : "s"}
                    </span>
                    <span>{formatProjectAge(project.updated_at)}</span>
                  </span>
                )}
              />
            );
          })}
        </ResourceGroup>
      ))}
    </ResourceList>
  );

  const isEditing = selectedId === "new" || mode === "edit";
  const detail = selectedId ? (
    isEditing ? (
      <ProjectEditor key={`${selectedId}:${mode || "create"}`} selectedId={selectedId} onSaved={reload} />
    ) : (
      <ProjectDetail key={selectedId} selectedId={selectedId} onChanged={reload} />
    )
  ) : (
    <div class="pane-empty">
      <Icon name="folder" size={28} />
      <h3>Select a project</h3>
      <p>Open a project to edit context, inspect linked tasks, or archive it.</p>
      <Button variant="primary" iconLeft={<Icon name="plus" size={13} />} onClick={() => navigateHash("#/projects/new")}>New project</Button>
    </div>
  );

  return (
    <AppShell route="projects">
      <PaneLayout
        listHeader={listHeader}
        listBody={listBody}
        detail={detail}
        hasSelection={!!selectedId}
        detailOwnsMobileBack={!!selectedId}
        listFirst
        class="resource-list-layout"
        onBack={() => navigateHash("#/projects")}
        backLabel="All projects"
      />
    </AppShell>
  );
}
