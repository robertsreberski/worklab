import { useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.js";
import { useFormSave } from "../lib/useFormSave.js";
import { pushToast } from "../lib/toast.js";
import { AppShell } from "../components/AppShell.jsx";
import { Icon } from "../components/Icon.jsx";
import { AgentPicker } from "../components/AgentPicker.jsx";

const PRIORITY_OPTIONS = [
  { value: 0, label: "None" },
  { value: 1, label: "P1 · Critical" },
  { value: 2, label: "P2 · High" },
  { value: 3, label: "P3 · Normal" },
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
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(mode === "edit");
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    api.listAgents().then((r) => setAgents(r.agents || [])).catch(() => setAgents([]));
  }, []);

  useEffect(() => {
    if (mode !== "edit" || !id) return;
    setLoading(true);
    api.getTask(id)
      .then((data) => {
        if (!data?.task) { setNotFound(true); return; }
        setDraft({
          title: data.task.title || "",
          description: data.task.description || "",
          instructions: data.task.instructions || "",
          executor_agent: data.task.executor_agent || null,
          reviewer_agent: data.task.reviewer_agent || null,
          priority: data.task.priority || 0,
          tags: data.task.tags || [],
        });
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
      pushToast("Task saved", { variant: "success" });
      window.location.hash = `#/tasks/${id}`;
    }
  });

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

  function cancel() {
    if (mode === "edit" && id) window.location.hash = `#/tasks/${id}`;
    else window.location.hash = "#/tasks";
  }

  const title = mode === "create" ? "New task" : "Edit task";

  return (
    <AppShell route="tasks" title={title}>
      <div class="task-edit">
        <header class="task-edit-head">
          <div>
            <div class="eyebrow">{mode === "create" ? "Create task" : "Edit"}</div>
            <h2>{mode === "create" ? "New task" : (draft.title || "Edit task")}</h2>
          </div>
          <div class="toolbar">
            <button type="button" class="button ghost" onClick={cancel}>Cancel</button>
            <button
              type="button"
              class="button primary"
              onClick={save}
              disabled={formSave.saving || !draft.title.trim()}
            >
              {formSave.saving ? "Saving..." : (mode === "create" ? "Create task" : "Save changes")}
            </button>
          </div>
        </header>
        <div class="task-edit-body">
          {notFound && <div class="form-error">Task not found. <a href="#/tasks">Back to list</a></div>}
          {loading && <div class="surface-panel" style={{ color: "var(--muted)" }}>Loading...</div>}
          {!loading && !notFound && (
            <>
              {formSave.error && <div class="form-error" role="alert">Save failed: {formSave.error}</div>}
              <div class="field">
                <label class="field-label">Title</label>
                <input
                  class="form-input"
                  placeholder="Short, actionable title"
                  value={draft.title}
                  onInput={(e) => update({ title: e.target.value })}
                  autoFocus={mode === "create"}
                />
              </div>
              <div class="field">
                <label class="field-label">Description</label>
                <textarea
                  class="form-input"
                  rows="4"
                  placeholder="What problem are we solving? Why does it matter?"
                  value={draft.description}
                  onInput={(e) => update({ description: e.target.value })}
                  style={{ fontFamily: "var(--sans)", fontSize: 13 }}
                />
                <span class="field-hint">Human-readable context. Supports Markdown.</span>
              </div>
              <div class="field">
                <label class="field-label">Instructions</label>
                <textarea
                  class="form-input mono-input"
                  rows="8"
                  placeholder="Precise instructions the executor agent should follow."
                  value={draft.instructions}
                  onInput={(e) => update({ instructions: e.target.value })}
                />
                <span class="field-hint">Passed verbatim to the executor agent.</span>
              </div>
              <div class="form-grid">
                <div class="field">
                  <label class="field-label">Executor</label>
                  <AgentPicker
                    value={draft.executor_agent}
                    onChange={(name) => update({ executor_agent: name })}
                    agents={agents}
                    placeholder="Pick an executor"
                    role="runs the work"
                  />
                </div>
                <div class="field">
                  <label class="field-label">Reviewer</label>
                  <AgentPicker
                    value={draft.reviewer_agent}
                    onChange={(name) => update({ reviewer_agent: name })}
                    agents={agents}
                    placeholder="Pick a reviewer (optional)"
                    role="verifies the result"
                  />
                </div>
                <div class="field">
                  <label class="field-label">Priority</label>
                  <select
                    class="form-input"
                    value={draft.priority}
                    onChange={(e) => update({ priority: Number(e.target.value) })}
                  >
                    {PRIORITY_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
                <div class="field">
                  <label class="field-label">Tags</label>
                  <input
                    class="form-input"
                    placeholder="comma,separated,tags"
                    value={(draft.tags || []).join(", ")}
                    onInput={(e) => update({
                      tags: e.target.value.split(",").map((t) => t.trim()).filter(Boolean),
                    })}
                  />
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </AppShell>
  );
}
