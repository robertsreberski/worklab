// §6.4 TaskEdit — create/edit one task.
// Sticky header with breadcrumb + Cancel + primary. Centered form 720px.
// FormSections: Core · Assignment. No Advanced twist-open (empty in baseline).
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
import { RadioGroup } from "../components/primitives/RadioGroup.jsx";
import { Chip } from "../components/primitives/Chip.jsx";
import { AgentPicker } from "../components/AgentPicker.jsx";
import { FormSection } from "../components/FormSection.jsx";
import { FormGrid } from "../components/FormGrid.jsx";
import { FormField } from "../components/FormField.jsx";
import { Banner } from "../components/Banner.jsx";
import { Modal } from "../components/Modal.jsx";
import { LoadingState } from "../components/LoadingState.jsx";

const PRIORITY_OPTIONS = [
  { value: 0, label: "None" },
  { value: 1, label: "P1" },
  { value: 2, label: "P2" },
  { value: 3, label: "P3" },
];

function emptyDraft() {
  return {
    title: "",
    description: "",
    instructions: "",
    executor_agent: null,
    reviewer_agent: null,
    priority: 0,
    tags: [],
  };
}

export function TaskEdit({ mode = "create", id = null }) {
  const [draft, setDraft] = useState(emptyDraft());
  const [baseline, setBaseline] = useState(emptyDraft());
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(mode === "edit");
  const [notFound, setNotFound] = useState(false);
  const [leaveModal, setLeaveModal] = useState(null); // pending destination
  const [tagDraft, setTagDraft] = useState("");
  const formRef = useRef(null);

  useEffect(() => {
    api.listAgents().then((r) => setAgents(r.agents || [])).catch(() => setAgents([]));
  }, []);

  useEffect(() => {
    if (mode !== "edit" || !id) return;
    setLoading(true);
    api.getTask(id)
      .then((data) => {
        if (!data?.task) { setNotFound(true); return; }
        const initial = {
          title: data.task.title || "",
          description: data.task.description || "",
          instructions: data.task.instructions || "",
          executor_agent: data.task.executor_agent || null,
          reviewer_agent: data.task.reviewer_agent || null,
          priority: data.task.priority || 0,
          tags: data.task.tags || [],
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
      window.location.hash = `#/tasks/${r.task.id}`;
    } else {
      await api.patchTask(id, patch);
      pushToast("Saved.", { variant: "success" });
      setBaseline(draft);
      window.location.hash = `#/tasks/${id}`;
    }
  });

  const isDirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(baseline), [draft, baseline]);

  function update(patch) {
    setDraft((d) => ({ ...d, ...patch }));
  }

  function save() {
    const payload = {
      title: draft.title.trim(),
      description: draft.description,
      instructions: draft.instructions,
      executor_agent: draft.executor_agent,
      reviewer_agent: draft.reviewer_agent,
      priority: Number(draft.priority) || 0,
      tags: draft.tags,
    };
    if (!payload.title) {
      pushToast("Title is required", { variant: "error" });
      return;
    }
    formSave.save(payload).catch(() => {});
  }

  function navigateAway(hash) {
    if (isDirty) {
      setLeaveModal(hash);
    } else {
      window.location.hash = hash;
    }
  }

  function cancel() {
    if (mode === "edit" && id) navigateAway(`#/tasks/${id}`);
    else navigateAway("#/tasks");
  }

  useGlobalShortcuts({
    cmds: (e) => { e.preventDefault(); save(); },
    cmdenter: (e) => { e.preventDefault(); save(); },
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

  const title = mode === "create" ? "New task" : "Edit task";

  return (
    <AppShell route="tasks" title={title}>
      <div class="task-edit">
        <header class="task-edit-head">
          <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)", minWidth: 0 }}>
            <IconButton
              icon={<Icon name="chevron-left" size={14} />}
              aria-label="Back"
              onClick={cancel}
            />
            <Breadcrumb items={[
              { label: "Tasks", href: "#/tasks" },
              ...(mode === "edit" ? [{ label: `#${String(id).slice(-6)}`, href: `#/tasks/${id}` }] : []),
              { label: mode === "create" ? "New" : "Edit" },
            ]} />
          </div>
          <div class="toolbar">
            <Button variant="ghost" onClick={cancel}>Cancel</Button>
            <Button
              variant={isDirty || mode === "create" ? "primary" : "secondary"}
              onClick={save}
              loading={formSave.saving}
              disabled={!draft.title.trim()}
            >
              {mode === "create" ? "Create task" : "Save"}
            </Button>
          </div>
        </header>
        <form
          ref={formRef}
          class="task-edit-body"
          onSubmit={(e) => { e.preventDefault(); save(); }}
        >
          {notFound && (
            <Banner variant="error" title="Task not found" detail="It may have been deleted." />
          )}
          {loading && <LoadingState caption="Loading task…" />}
          {!loading && !notFound && (
            <>
              {formSave.error && (
                <Banner
                  variant="error"
                  title="Save failed"
                  detail={formSave.error}
                  actions={<Button size="sm" variant="secondary" onClick={save}>Retry</Button>}
                />
              )}

              <FormSection kicker="Core" title="Task definition" description="What the executor agent should do and why.">
                <FormField label="Title" required>
                  <Input
                    placeholder="Short, actionable title"
                    value={draft.title}
                    onInput={(e) => update({ title: e.target.value })}
                    autoFocus={mode === "create"}
                  />
                </FormField>
                <FormField
                  label="Description"
                  hint="Human-readable context. Supports Markdown."
                >
                  <Textarea
                    rows={5}
                    autoGrow
                    placeholder="What problem are we solving? Why does it matter?"
                    value={draft.description}
                    onInput={(e) => update({ description: e.target.value })}
                  />
                </FormField>
                <FormField
                  label="Instructions"
                  hint="Passed verbatim to the executor agent."
                >
                  <Textarea
                    rows={8}
                    monospace
                    autoGrow
                    placeholder="Precise instructions the executor agent should follow."
                    value={draft.instructions}
                    onInput={(e) => update({ instructions: e.target.value })}
                  />
                </FormField>
              </FormSection>

              <FormSection kicker="Assignment" title="Who runs it">
                <FormGrid columns={2}>
                  <FormField label="Executor" hint="The agent that runs the work.">
                    <AgentPicker
                      value={draft.executor_agent}
                      onChange={(name) => update({ executor_agent: name })}
                      agents={agents}
                      placeholder="Pick an executor"
                    />
                  </FormField>
                  <FormField label="Reviewer" hint="Optional agent that verifies the result.">
                    <AgentPicker
                      value={draft.reviewer_agent}
                      onChange={(name) => update({ reviewer_agent: name })}
                      agents={agents}
                      placeholder="Pick a reviewer"
                    />
                  </FormField>
                  <FormField label="Priority">
                    <RadioGroup
                      ariaLabel="Priority"
                      value={draft.priority}
                      onChange={(v) => update({ priority: v })}
                      options={PRIORITY_OPTIONS}
                    />
                  </FormField>
                  <FormField label="Tags" hint="Press Enter to add a tag.">
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)", alignItems: "center" }}>
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
                </FormGrid>
              </FormSection>
            </>
          )}
        </form>
      </div>

      {/* Unsaved-changes guard */}
      <Modal
        open={!!leaveModal}
        onClose={() => setLeaveModal(null)}
        title="You have unsaved changes"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setLeaveModal(null)}>Keep editing</Button>
            <Button
              variant="destructive"
              onClick={() => { const h = leaveModal; setLeaveModal(null); window.location.hash = h; }}
            >Discard</Button>
            <Button
              variant="primary"
              loading={formSave.saving}
              onClick={async () => {
                try {
                  await save();
                  const h = leaveModal; setLeaveModal(null);
                  if (h) window.location.hash = h;
                } catch { /* handled in save */ }
              }}
            >Save & leave</Button>
          </>
        }
      >
        <p>Your changes have not been saved.</p>
      </Modal>
    </AppShell>
  );
}
