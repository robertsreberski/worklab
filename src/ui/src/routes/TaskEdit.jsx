// §6.4 TaskEdit — create/edit one task.
// Sticky header with breadcrumb + Cancel + primary + ⌘S hint.
// Two-column body: left (title · instructions · dependencies),
// right rail (stage grid · owner · reviewer · tags).
// ⌘S saves. Esc navigates back (unsaved-guard modal if dirty).

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api } from "../lib/api.js";
import { useFormSave } from "../lib/useFormSave.js";
import { pushToast } from "../lib/toast.js";
import { useGlobalShortcuts } from "../lib/useGlobalShortcuts.js";
import { AppShell, MobilePillRow, MobileTopbar } from "../components/AppShell.jsx";
import { Button } from "../components/primitives/Button.jsx";
import { Input } from "../components/primitives/Input.jsx";
import { Textarea } from "../components/primitives/Textarea.jsx";
import { MentionableTextarea } from "../components/MentionableTextarea.jsx";
import { Select } from "../components/primitives/Select.jsx";
import { Chip } from "../components/primitives/Chip.jsx";
import { StageToken } from "../components/primitives/StageToken.jsx";
import { TagInput } from "../components/primitives/SpecialInputs.jsx";
import { AgentPicker } from "../components/AgentPicker.jsx";
import { ProjectPicker } from "../components/ProjectPicker.jsx";
import { TeamPicker } from "../components/TeamPicker.jsx";
import { FormField } from "../components/FormField.jsx";
import { FormSection } from "../components/FormSection.jsx";
import { Banner } from "../components/Banner.jsx";
import { Modal } from "../components/Modal.jsx";
import { LoadingState } from "../components/LoadingState.jsx";
import { DetailHead, PanelGrid, SectionMarker, Toolbar } from "../components/layout/index.js";
import { navigateHash, proceedToHash, useUnsavedChangesGuard } from "../lib/navigation.js";
import { taskDisplayKey, taskRouteId } from "../lib/display.js";
import { useAppResume } from "../lib/pageVisibility.js";

// Stage grid in the right rail.
const TASK_STAGE_OPTIONS = [
  { value: "plan" },
  { value: "execute" },
  { value: "review" },
  { value: "awaiting_children" },
  { value: "awaiting_user" },
  { value: "blocked" },
  { value: "done" },
];
const TASK_CREATE_STAGE_OPTIONS = TASK_STAGE_OPTIONS.filter((option) => ["plan", "execute"].includes(option.value));

export function taskStageOptionsForMode(mode) {
  return mode === "create" ? TASK_CREATE_STAGE_OPTIONS : TASK_STAGE_OPTIONS;
}

const TASK_EDIT_SECTIONS = [
  { id: "task-edit-title", num: "01", label: "Title", meta: "Required" },
  { id: "task-edit-instructions", num: "02", label: "Instructions", meta: "Markdown" },
  { id: "task-edit-dependencies", num: "03", label: "Dependencies", meta: "Blockers" },
];
const TASK_CREATE_SECTIONS = [
  { id: "task-edit-title", num: "01", label: "Details", meta: "Primary" },
  { id: "task-edit-instructions", num: "02", label: "Instructions", meta: "Markdown" },
];

const RUN_POLICY_OPTIONS = [
  { value: "auto_plan_execute", label: "Auto" },
  { value: "manual", label: "Manual" },
];

const DEFAULT_RUN_POLICY = "auto_plan_execute";

function emptyDraft() {
  return {
    title: "",
    instructions: "",
    owner_agent: null,
    planner_agent: null,
    reviewer_agent: null,
    stage: "plan",
    run_policy: DEFAULT_RUN_POLICY,
    project_id: null,
    team_id: null,
    tags: [],
    blocked_by_ids: [],
  };
}

function newClientRequestId() {
  if (globalThis.crypto?.randomUUID) return `task-create-${globalThis.crypto.randomUUID()}`;
  return `task-create-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function TaskEdit({ mode = "create", id = null, query = {} }) {
  const [draft, setDraft] = useState(emptyDraft());
  const [baseline, setBaseline] = useState(emptyDraft());
  const [agents, setAgents] = useState([]);
  const [projects, setProjects] = useState([]);
  const [teams, setTeams] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [loadedTask, setLoadedTask] = useState(null);
  const [loading, setLoading] = useState(mode === "edit");
  const [notFound, setNotFound] = useState(false);
  const [dependencyDraft, setDependencyDraft] = useState("");
  const formRef = useRef(null);
  const createRequestIdRef = useRef(mode === "create" ? newClientRequestId() : null);
  const appliedProjectPrefillIdRef = useRef(null);
  const projectPrefillInput = mode === "create"
    ? String(query?.project || query?.project_id || "").trim()
    : "";

  useEffect(() => {
    const controller = new AbortController();
    api.listAgents({ signal: controller.signal }).then((r) => setAgents(r.agents || [])).catch((err) => { if (err?.name !== "AbortError") setAgents([]); });
    api.listProjects({ include_archived: "true" }, { signal: controller.signal }).then((r) => setProjects(r.projects || [])).catch((err) => { if (err?.name !== "AbortError") setProjects([]); });
    api.listTeams({ include_archived: "true" }, { signal: controller.signal }).then((r) => setTeams(r.teams || [])).catch((err) => { if (err?.name !== "AbortError") setTeams([]); });
    api.listTasks({ view: "summary" }, { signal: controller.signal }).then((r) => setTasks(r.tasks || [])).catch((err) => { if (err?.name !== "AbortError") setTasks([]); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (mode !== "edit" || !id) return;
    const controller = new AbortController();
    setLoading(true);
    setNotFound(false);
    setLoadedTask(null);
    api.getTask(id, { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        if (!data?.task) { setLoadedTask(null); setNotFound(true); return; }
        setLoadedTask(data.task);
        const initial = {
          title: data.task.title || "",
          instructions: data.task.instructions || "",
          owner_agent: data.task.owner_agent || null,
          planner_agent: data.task.planner_agent || null,
          reviewer_agent: data.task.reviewer_agent || null,
          stage: data.task.stage || "plan",
          run_policy: data.task.run_policy || DEFAULT_RUN_POLICY,
          project_id: data.task.project_id || null,
          team_id: data.task.team_id || null,
          tags: data.task.tags || [],
          blocked_by_ids: data.task.dependency_ids || [],
        };
        setDraft(initial);
        setBaseline(initial);
      })
      .catch((err) => { if (err?.name !== "AbortError") setNotFound(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [mode, id]);

  const formSave = useFormSave(async (patch) => {
    if (mode === "create") {
      const r = await api.createTask(patch);
      pushToast("Task created", { variant: "success" });
      return taskRouteId(r.task);
    } else {
      const r = await api.patchTask(id, patch);
      const cascaded = Number(r?.task?.cascade?.project_id_descendants || 0);
      const message = cascaded > 0
        ? `Saved. Project also applied to ${cascaded} subtask${cascaded === 1 ? "" : "s"}.`
        : "Saved.";
      pushToast(message, { variant: "success" });
      setBaseline(draft);
      return loadedTask ? taskRouteId(loadedTask) : id;
    }
  });

  const isDirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(baseline), [draft, baseline]);
  useAppResume(() => {
    api.listAgents().then((r) => setAgents(r.agents || [])).catch(() => setAgents([]));
    api.listProjects({ include_archived: "true" }).then((r) => setProjects(r.projects || [])).catch(() => setProjects([]));
    api.listTeams({ include_archived: "true" }).then((r) => setTeams(r.teams || [])).catch(() => setTeams([]));
    api.listTasks({ view: "summary" }).then((r) => setTasks(r.tasks || [])).catch(() => setTasks([]));
    if (mode !== "edit" || !id || isDirty) return;
    api.getTask(id)
      .then((data) => {
        if (!data?.task) { setLoadedTask(null); setNotFound(true); return; }
        setLoadedTask(data.task);
        const next = {
          title: data.task.title || "",
          instructions: data.task.instructions || "",
          owner_agent: data.task.owner_agent || null,
          planner_agent: data.task.planner_agent || null,
          reviewer_agent: data.task.reviewer_agent || null,
          stage: data.task.stage || "plan",
          run_policy: data.task.run_policy || DEFAULT_RUN_POLICY,
          project_id: data.task.project_id || null,
          team_id: data.task.team_id || null,
          tags: data.task.tags || [],
          blocked_by_ids: data.task.dependency_ids || [],
        };
        setDraft(next);
        setBaseline(next);
        setNotFound(false);
      })
      .catch(() => setNotFound(true));
  });

  useEffect(() => {
    if (mode !== "create") return;
    if (!projectPrefillInput) {
      appliedProjectPrefillIdRef.current = null;
      return;
    }
    if (!projects.length) return;
    const matchedProject = projects.find((project) => (
      project.id === projectPrefillInput
      || project.slug === projectPrefillInput
      || project.name === projectPrefillInput
    ));
    if (!matchedProject) return;

    const previousPrefillId = appliedProjectPrefillIdRef.current;
    if (draft.project_id && draft.project_id !== previousPrefillId) return;
    if (draft.project_id === matchedProject.id && previousPrefillId === matchedProject.id) return;

    appliedProjectPrefillIdRef.current = matchedProject.id;
    const applyProjectPrefill = (current) => {
      if (current.project_id && current.project_id !== previousPrefillId) return current;
      return { ...current, project_id: matchedProject.id };
    };
    setDraft(applyProjectPrefill);
    setBaseline(applyProjectPrefill);
  }, [mode, projectPrefillInput, projects, draft.project_id]);

  function update(patch) {
    setDraft((d) => ({ ...d, ...patch }));
  }

  async function save({ navigateOnSuccess = true } = {}) {
    const payload = {
      title: draft.title.trim(),
      instructions: draft.instructions,
      owner_agent: draft.owner_agent,
      planner_agent: draft.planner_agent,
      reviewer_agent: draft.reviewer_agent,
      stage: draft.stage || "plan",
      run_policy: draft.run_policy || DEFAULT_RUN_POLICY,
      project_id: draft.project_id || null,
      team_id: draft.team_id || null,
      tags: draft.tags,
      blocked_by_ids: draft.blocked_by_ids || [],
    };
    if (mode === "create") payload.client_request_id = createRequestIdRef.current;
    if (!payload.title) {
      pushToast("Title is required", { variant: "error" });
      throw new Error("Title is required");
    }
    const savedId = await formSave.save(payload);
    if (savedId) setBaseline(draft);
    if (navigateOnSuccess && savedId) {
      proceedToHash(`#/tasks/${savedId}`);
    }
    return savedId;
  }

  const guard = useUnsavedChangesGuard({ isDirty, onSave: () => save({ navigateOnSuccess: false }) });

  function cancel() {
    if (mode === "edit" && id) guard.requestNavigation(`#/tasks/${loadedTask ? taskRouteId(loadedTask) : encodeURIComponent(id)}`);
    else guard.requestNavigation("#/tasks");
  }

  useGlobalShortcuts({
    cmds: (e) => { e.preventDefault(); save().catch(() => {}); },
    cmdenter: (e) => { e.preventDefault(); save().catch(() => {}); },
    Escape: () => cancel(),
  });

  const selectedDependencyMap = useMemo(
    () => new Map(tasks.map((task) => [task.id, task])),
    [tasks],
  );

  const dependencyOptions = useMemo(() => {
    return tasks
      .filter((task) => task.id !== loadedTask?.id && task.id !== id && taskDisplayKey(task) !== taskDisplayKey(id) && !draft.blocked_by_ids.includes(task.id))
      .map((task) => ({
        value: task.id,
        label: task.title,
        description: `${(task.stage || "plan").replaceAll("_", " ")} · ${taskDisplayKey(task)}`,
      }));
  }, [draft.blocked_by_ids, id, loadedTask?.id, tasks]);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === draft.project_id) || null,
    [projects, draft.project_id],
  );
  const truncatedProjectContext = useMemo(() => {
    const text = selectedProject?.context || "";
    if (!text) return "";
    return text.length > 240 ? `${text.slice(0, 240).trimEnd()}…` : text;
  }, [selectedProject]);

  function addDependency(taskId) {
    if (!taskId || draft.blocked_by_ids.includes(taskId)) return;
    update({ blocked_by_ids: [...draft.blocked_by_ids, taskId] });
    setDependencyDraft("");
  }

  function removeDependency(taskId) {
    update({ blocked_by_ids: draft.blocked_by_ids.filter((entry) => entry !== taskId) });
  }

  function renderProjectField({ showPreview = false } = {}) {
    return (
      <FormField label="Project" hint={mode === "create" ? "Adds shared context and workdir to runs." : "Adds shared context and optional workdir to runs."}>
        <ProjectPicker
          value={draft.project_id || ""}
          onChange={(value) => update({ project_id: value || null })}
          projects={projects}
          placeholder="No project"
          ariaLabel="Project"
        />
        {showPreview && selectedProject && (
          <div class="task-edit-project-preview">
            <div class="task-edit-project-preview-row">
              <span class="task-edit-project-preview-label">Workdir</span>
              <span class="task-edit-project-preview-value mono">
                {selectedProject.workdir || "Default workspace"}
              </span>
            </div>
            <div class="task-edit-project-preview-row">
              <span class="task-edit-project-preview-label">Worktrees</span>
              <span class="task-edit-project-preview-value">
                {selectedProject.worktree_mode === "required" ? "Required" : selectedProject.worktree_mode === "auto" ? "Auto" : "Off"}
              </span>
            </div>
            {selectedProject.context && (
              <div class="task-edit-project-preview-context">
                {truncatedProjectContext}
              </div>
            )}
          </div>
        )}
      </FormField>
    );
  }

  function renderOwnerField() {
    return (
      <FormField label="Owner" hint="Runs the work. Also plans when no planner is set.">
        <AgentPicker
          value={draft.owner_agent}
          onChange={(name) => update({ owner_agent: name })}
          agents={agents}
          placeholder="Pick an owner"
          role="owner"
        />
      </FormField>
    );
  }

  function renderDependencyField() {
    return (
      <FormField
        label="Depends on"
        hint="Optional blockers. A task cannot run until every dependency is done."
      >
        <div class="dependency-picker">
          {draft.blocked_by_ids.length > 0 && (
            <Toolbar class="dependency-chip-list" align="start">
              {draft.blocked_by_ids.map((dependencyId) => {
                const dependency = selectedDependencyMap.get(dependencyId);
                const label = dependency?.title || dependencyId;
                return (
                  <Chip key={dependencyId} variant="tag" onRemove={() => removeDependency(dependencyId)}>
                    {label}
                  </Chip>
                );
              })}
            </Toolbar>
          )}
          <Select
            value={dependencyDraft}
            onChange={addDependency}
            options={dependencyOptions}
            placeholder="Link another task..."
            ariaLabel="Add dependency"
            searchable
          />
        </div>
      </FormField>
    );
  }

  const heading = mode === "create" ? "New task" : "Edit task";
  const idDisplay = mode === "edit" && id ? taskDisplayKey(loadedTask || id) : null;
  const saveButtonVariant = isDirty || mode === "create" ? "primary" : "secondary";
  const saveButtonLabel = mode === "create" ? "Create task" : "Save";
  const titleMeta = (
    <>
      {mode === "edit" && idDisplay && <span>{idDisplay}</span>}
      <span>{isDirty ? "Unsaved changes" : "Saved"}</span>
    </>
  );
  const mobileActionDock = (
    <>
      <Button variant="secondary" onClick={cancel}>Cancel</Button>
      <Button
        variant={saveButtonVariant}
        onClick={() => save().catch(() => {})}
        loading={formSave.saving}
        disabled={!draft.title.trim()}
      >
        {saveButtonLabel}
      </Button>
    </>
  );
  const activeSections = mode === "create" ? TASK_CREATE_SECTIONS : TASK_EDIT_SECTIONS;
  const railCardCount = mode === "create" ? 7 : 8;

  function renderTaskEditRail() {
    const stageOptions = taskStageOptionsForMode(mode);
    return (
      <div class="task-edit-rail-content">
        <FormField label={mode === "create" ? "Initial stage" : "Stage"}>
          <PanelGrid class="stage-grid status-grid">
            {stageOptions.map((opt) => (
              <StageToken
                key={opt.value}
                stage={opt.value}
                variant="grid"
                active={draft.stage === opt.value}
                onClick={() => update({ stage: opt.value })}
              />
            ))}
          </PanelGrid>
        </FormField>

        {mode !== "create" && renderOwnerField()}

        <FormField label="Run mode" hint="Auto mode starts eligible stages after blockers clear.">
          <Select
            variant="native"
            value={draft.run_policy || DEFAULT_RUN_POLICY}
            onChange={(value) => update({ run_policy: value })}
            options={RUN_POLICY_OPTIONS}
            ariaLabel="Run mode"
          />
        </FormField>

        <FormField label="Planner" hint="Optional. Falls back to owner.">
          <AgentPicker
            value={draft.planner_agent}
            onChange={(name) => update({ planner_agent: name })}
            agents={agents}
            placeholder="Pick a planner"
            role="planner"
          />
        </FormField>

        {mode !== "create" && renderProjectField({ showPreview: true })}

        <FormField label="Team" hint="Optional task override. Defaults to the project team.">
          <TeamPicker
            value={draft.team_id || ""}
            onChange={(teamId) => update({ team_id: teamId })}
            teams={teams}
            clearLabel="Project default"
            placeholder="Pick a team"
            ariaLabel="Task team"
          />
        </FormField>

        <FormField label="Reviewer" hint="Optional verifier.">
          <AgentPicker
            value={draft.reviewer_agent}
            onChange={(name) => update({ reviewer_agent: name })}
            agents={agents}
            placeholder="Pick a reviewer"
            role="reviewer"
          />
        </FormField>

        <FormField label="Tags" hint="Press Enter to add.">
          <TagInput
            value={draft.tags || []}
            onChange={(tags) => update({ tags })}
            placeholder="Add tag..."
          />
        </FormField>

        {mode === "create" && renderDependencyField()}
      </div>
    );
  }

  return (
    <AppShell
      route="tasks"
      mobileActionDock={mobileActionDock}
      mobileTopbar={<MobileTopbar title={mode === "create" ? "New task" : idDisplay || "Edit task"} backLabel="Tasks" onBack={cancel} />}
      drawerTitle="Settings"
      drawerKicker={mode === "create" ? "New task" : idDisplay || "Task"}
      drawerContent={!loading && !notFound ? renderTaskEditRail() : null}
      sections={activeSections}
    >
      <div class="task-edit">
        <DetailHead
          ariaLabel={heading}
          backLabel="Back"
          onBack={cancel}
          crumbs={[
            { label: "Tasks", href: "#/tasks" },
            ...(mode === "edit" ? [{ label: idDisplay, href: `#/tasks/${loadedTask ? taskRouteId(loadedTask) : encodeURIComponent(id)}` }] : []),
            { label: mode === "create" ? "New" : "Edit" },
          ]}
          class="task-edit-head task-edit-task-head"
          kicker={mode === "create" ? "New task" : "Task editor"}
          idPrefix={idDisplay}
          title={draft.title}
          titlePlaceholder="Untitled task"
          meta={titleMeta}
          hint
          glyph="T"
          subBar={<MobilePillRow railLabel="Settings" railCount={railCardCount} sections={activeSections} />}
          actionsClass="task-edit-toolbar"
          actions={(
            <>
              <Button variant="ghost" onClick={cancel}>Cancel</Button>
              <Button
                variant={saveButtonVariant}
                onClick={() => save().catch(() => {})}
                loading={formSave.saving}
                disabled={!draft.title.trim()}
              >
                {saveButtonLabel}
              </Button>
            </>
          )}
        />
        <form
          ref={formRef}
          class="task-edit-body"
          onSubmit={(e) => { e.preventDefault(); save().catch(() => {}); }}
        >
          {notFound && (
            <Banner variant="error" title="Task not found" detail="It may have been deleted." />
          )}
          {loading && <LoadingState caption="Loading task…" />}
          {!loading && !notFound && (
            <div class="task-edit-grid editor-body">
              {/* Left column — identity & instructions & deps */}
              <div class="task-edit-main editor-main">
                {formSave.error && (
                  <Banner
                    variant="error"
                    title="Save failed"
                    detail={formSave.error}
                    actions={<Button size="sm" variant="secondary" onClick={() => save().catch(() => {})}>Retry</Button>}
                  />
                )}

                <FormSection class="task-edit-section" aria-labelledby="task-edit-title">
                  <SectionMarker id="task-edit-title" num="01" kicker={mode === "create" ? "Details" : "Title"} meta={mode === "create" ? "Primary" : "Required"} />
                  <FormField label="Title" required>
                    <Input
                      placeholder="Short, actionable title"
                      value={draft.title}
                      onInput={(e) => update({ title: e.target.value })}
                      autoFocus={mode === "create"}
                    />
                  </FormField>
                  {mode === "create" && (
                    <div class="task-edit-primary-grid">
                      {renderProjectField()}
                      {renderOwnerField()}
                    </div>
                  )}
                </FormSection>

                <FormSection class="task-edit-section" aria-labelledby="task-edit-instructions">
                  <SectionMarker id="task-edit-instructions" num="02" kicker="Instructions" meta="Markdown" />
                  <FormField
                    label="Instructions"
                    hint="Optional context sent to the owner. Markdown supported."
                  >
                    <MentionableTextarea
                      rows={10}
                      monospace
                      autoGrow
                      placeholder="Add any context, constraints, references, or notes for the owner."
                      value={draft.instructions}
                      onInput={(e) => update({ instructions: e.target.value })}
                    />
                  </FormField>
                </FormSection>

                {mode !== "create" && (
                  <FormSection class="task-edit-section" aria-labelledby="task-edit-dependencies">
                  <SectionMarker id="task-edit-dependencies" num="03" kicker="Dependencies" meta="Blockers" />
                    {renderDependencyField()}
                  </FormSection>
                )}
              </div>

              {/* Right rail — assignment & stage */}
              <aside class="task-edit-rail editor-rail">
                {renderTaskEditRail()}
              </aside>
            </div>
          )}
        </form>
      </div>
      {/* Unsaved-changes guard */}
      <Modal
        open={guard.promptOpen}
        onClose={guard.keepEditing}
        title="You have unsaved changes"
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={guard.keepEditing}>Keep editing</Button>
            <Button
              variant="destructive"
              onClick={guard.discardAndLeave}
            >Discard</Button>
            <Button
              variant="primary"
              loading={formSave.saving}
              onClick={() => guard.saveAndLeave().catch(() => {})}
            >Save & leave</Button>
          </>
        }
      >
        <p>Your changes have not been saved.</p>
      </Modal>
    </AppShell>
  );
}
