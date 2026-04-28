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
import { AppShell } from "../components/AppShell.jsx";
import { Icon } from "../components/Icon.jsx";
import { Breadcrumb } from "../components/primitives/Breadcrumb.jsx";
import { Button } from "../components/primitives/Button.jsx";
import { IconButton } from "../components/primitives/IconButton.jsx";
import { Input } from "../components/primitives/Input.jsx";
import { Textarea } from "../components/primitives/Textarea.jsx";
import { Select } from "../components/primitives/Select.jsx";
import { Chip } from "../components/primitives/Chip.jsx";
import { Kbd } from "../components/primitives/Kbd.jsx";
import { Tooltip } from "../components/primitives/Tooltip.jsx";
import { AgentPicker } from "../components/AgentPicker.jsx";
import { FormField } from "../components/FormField.jsx";
import { Banner } from "../components/Banner.jsx";
import { Modal } from "../components/Modal.jsx";
import { LoadingState } from "../components/LoadingState.jsx";
import { navigateHash, proceedToHash, useUnsavedChangesGuard } from "../lib/navigation.js";
import { taskDisplayKey, taskRouteId } from "../lib/display.js";

// Stage grid in the right rail.
const STATUS_OPTIONS = [
  { value: "plan", label: "Plan", icon: "◉", color: "var(--accent)" },
  { value: "execute", label: "Execute", icon: "○", color: "var(--status-todo)" },
  { value: "review", label: "Review", icon: "◉", color: "var(--status-review)" },
  { value: "awaiting_children", label: "Waiting", icon: "◐", color: "var(--status-progress)" },
  { value: "awaiting_user", label: "Needs input", icon: "▲", color: "var(--status-error)" },
  { value: "blocked", label: "Blocked", icon: "▲", color: "var(--status-error)" },
  { value: "done", label: "Done", icon: "●", color: "var(--status-done)" },
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
    tags: [],
    blocked_by_ids: [],
  };
}

function newClientRequestId() {
  if (globalThis.crypto?.randomUUID) return `task-create-${globalThis.crypto.randomUUID()}`;
  return `task-create-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function TaskEdit({ mode = "create", id = null }) {
  const [draft, setDraft] = useState(emptyDraft());
  const [baseline, setBaseline] = useState(emptyDraft());
  const [agents, setAgents] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [loadedTask, setLoadedTask] = useState(null);
  const [loading, setLoading] = useState(mode === "edit");
  const [notFound, setNotFound] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  const [dependencyDraft, setDependencyDraft] = useState("");
  const formRef = useRef(null);
  const createRequestIdRef = useRef(mode === "create" ? newClientRequestId() : null);

  useEffect(() => {
    api.listAgents().then((r) => setAgents(r.agents || [])).catch(() => setAgents([]));
    api.listTasks().then((r) => setTasks(r.tasks || [])).catch(() => setTasks([]));
  }, []);

  useEffect(() => {
    if (mode !== "edit" || !id) return;
    setLoading(true);
    setNotFound(false);
    setLoadedTask(null);
    api.getTask(id)
      .then((data) => {
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
          tags: data.task.tags || [],
          blocked_by_ids: data.task.dependency_ids || [],
        };
        setDraft(initial);
        setBaseline(initial);
      })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [mode, id]);

  const formSave = useFormSave(async (patch) => {
    if (mode === "create") {
      const r = await api.createTask(patch);
      pushToast("Task created", { variant: "success" });
      return taskRouteId(r.task);
    } else {
      await api.patchTask(id, patch);
      pushToast("Saved.", { variant: "success" });
      setBaseline(draft);
      return loadedTask ? taskRouteId(loadedTask) : id;
    }
  });

  const isDirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(baseline), [draft, baseline]);

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

  function commitTagDraft() {
    const t = tagDraft.trim();
    if (!t) return;
    if (draft.tags.includes(t)) { setTagDraft(""); return; }
    update({ tags: [...draft.tags, t] });
    setTagDraft("");
  }

  function removeTag(t) {
    update({ tags: draft.tags.filter((x) => x !== t) });
  }

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

  function addDependency(taskId) {
    if (!taskId || draft.blocked_by_ids.includes(taskId)) return;
    update({ blocked_by_ids: [...draft.blocked_by_ids, taskId] });
    setDependencyDraft("");
  }

  function removeDependency(taskId) {
    update({ blocked_by_ids: draft.blocked_by_ids.filter((entry) => entry !== taskId) });
  }

  const heading = mode === "create" ? "New task" : "Edit task";
  const idDisplay = mode === "edit" && id ? taskDisplayKey(loadedTask || id) : null;
  const saveButtonVariant = isDirty || mode === "create" ? "primary" : "secondary";
  const saveButtonLabel = mode === "create" ? "Create task" : "Save";
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

  return (
    <AppShell route="tasks" mobileActionDock={mobileActionDock}>
      <div class="task-edit">
        <header class="task-edit-head" aria-label={heading}>
          <div class="task-edit-head-left">
            <IconButton
              icon={<Icon name="chevron-left" size={14} />}
              aria-label="Back"
              onClick={cancel}
            />
            <Breadcrumb items={[
              { label: "Tasks", href: "#/tasks" },
              ...(mode === "edit" ? [{ label: idDisplay, href: `#/tasks/${loadedTask ? taskRouteId(loadedTask) : encodeURIComponent(id)}` }] : []),
              { label: mode === "create" ? "New" : "Edit" },
            ]} />
          </div>
          <div class="toolbar task-edit-toolbar">
            <span class="task-edit-shortcut" aria-hidden="true">
              <Kbd>⌘</Kbd><Kbd>S</Kbd> save
            </span>
            <Button variant="ghost" onClick={cancel}>Cancel</Button>
            <Button
              variant={saveButtonVariant}
              onClick={() => save().catch(() => {})}
              loading={formSave.saving}
              disabled={!draft.title.trim()}
            >
              {saveButtonLabel}
            </Button>
          </div>
        </header>
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
            <div class="task-edit-grid">
              {/* Left column — identity & instructions & deps */}
              <div class="task-edit-main">
                <div class="task-edit-eyebrow-block">
                  <div class="all-caps task-edit-eyebrow">
                    {mode === "create" ? "New task" : "Editing task"}
                  </div>
                  <h2 class="task-edit-title">
                    {idDisplay && <span class="mono task-edit-title-id">{idDisplay}</span>}
                    {draft.title || <span class="task-edit-title-placeholder">Untitled task</span>}
                  </h2>
                </div>

                {formSave.error && (
                  <Banner
                    variant="error"
                    title="Save failed"
                    detail={formSave.error}
                    actions={<Button size="sm" variant="secondary" onClick={() => save().catch(() => {})}>Retry</Button>}
                  />
                )}

                <FormField label="Title" required>
                  <Input
                    placeholder="Short, actionable title"
                    value={draft.title}
                    onInput={(e) => update({ title: e.target.value })}
                    autoFocus={mode === "create"}
                  />
                </FormField>

                <FormField
                  label="Instructions"
                  hint="Sent to the owner. Markdown supported."
                >
                  <Textarea
                    rows={10}
                    monospace
                    autoGrow
                    placeholder="What should the owner do?"
                    value={draft.instructions}
                    onInput={(e) => update({ instructions: e.target.value })}
                  />
                </FormField>

                <FormField
                  label="Depends on"
                  hint="Optional blockers. A task cannot run until every dependency is done."
                >
                  <div class="dependency-picker">
                    {draft.blocked_by_ids.length > 0 && (
                      <div class="dependency-chip-list">
                        {draft.blocked_by_ids.map((dependencyId) => {
                          const dependency = selectedDependencyMap.get(dependencyId);
                          const label = dependency?.title || dependencyId;
                          return (
                            <Chip key={dependencyId} variant="tag" onRemove={() => removeDependency(dependencyId)}>
                              {label}
                            </Chip>
                          );
                        })}
                      </div>
                    )}
                    <Select
                      value={dependencyDraft}
                      onChange={addDependency}
                      options={dependencyOptions}
                      placeholder="Link another task…"
                      ariaLabel="Add dependency"
                      searchable
                    />
                  </div>
                </FormField>
              </div>

              {/* Right rail — assignment & stage */}
              <aside class="task-edit-rail">
                <FormField label="Stage">
                  <div class="status-grid">
                    {STATUS_OPTIONS.map((opt) => {
                      const active = draft.stage === opt.value;
                      const btn = (
                        <button
                          key={opt.value}
                          type="button"
                          class={`status-grid-btn ${active ? "active" : ""}`}
                          style={{ "--status-color": opt.color }}
                          aria-pressed={active}
                          disabled={opt.disabled}
                          onClick={() => !opt.disabled && update({ stage: opt.value })}
                        >
                          <span class="status-grid-icon" aria-hidden="true">{opt.icon}</span>
                          <span class="status-grid-label">{opt.label}</span>
                        </button>
                      );
                      return opt.disabled ? (
                        <Tooltip key={opt.value} label={opt.disabledHint} placement="top">
                          {btn}
                        </Tooltip>
                      ) : btn;
                    })}
                  </div>
                </FormField>

                <FormField label="Owner" hint="Required for work. Also plans when no planner is set.">
                  <AgentPicker
                    value={draft.owner_agent}
                    onChange={(name) => update({ owner_agent: name })}
                    agents={agents}
                    placeholder="Pick an owner"
                    role="owner"
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

                <FormField label="Run mode" hint="Auto mode starts eligible stages after blockers clear.">
                  <Select
                    variant="native"
                    value={draft.run_policy || DEFAULT_RUN_POLICY}
                    onChange={(value) => update({ run_policy: value })}
                    options={RUN_POLICY_OPTIONS}
                    ariaLabel="Run mode"
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
                  <div class="tag-input-row">
                    {(draft.tags || []).map((t) => (
                      <Chip key={t} variant="tag" onRemove={() => removeTag(t)}>{t}</Chip>
                    ))}
                    <Input
                      size="sm"
                      placeholder="Add tag…"
                      value={tagDraft}
                      onInput={(e) => setTagDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === ",") {
                          e.preventDefault();
                          commitTagDraft();
                        } else if (e.key === "Backspace" && !tagDraft && draft.tags.length) {
                          removeTag(draft.tags[draft.tags.length - 1]);
                        }
                      }}
                      onBlur={commitTagDraft}
                    />
                  </div>
                </FormField>
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
        size="sm"
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
