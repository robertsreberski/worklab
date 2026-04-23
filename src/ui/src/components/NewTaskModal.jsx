import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../lib/api.js";
import { pushToast } from "../lib/toast.js";
import { useFocusTrap } from "../lib/useFocusTrap.js";
import { SelectField } from "./SelectField.jsx";

const RECALL_KEY = "worklab.lastTaskAgents";

function loadRecall() {
  try {
    const raw = localStorage.getItem(RECALL_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveRecall(executor, reviewer) {
  try {
    localStorage.setItem(RECALL_KEY, JSON.stringify({ executor, reviewer }));
  } catch { /* storage unavailable */ }
}

export function NewTaskModal({ onClose, onCreated }) {
  const recalled = loadRecall();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [executorAgent, setExecutorAgent] = useState(recalled?.executor || "");
  const [reviewerAgent, setReviewerAgent] = useState(recalled?.reviewer || "");
  const [agents, setAgents] = useState([]);
  const [busy, setBusy] = useState(false);
  const modalRef = useRef(null);
  useFocusTrap(modalRef, { active: true, onEscape: onClose });

  useEffect(() => {
    api.listAgents().then((r) => {
      const list = r.agents || [];
      setAgents(list);
      // Drop recalled agents that no longer exist.
      if (executorAgent && !list.find((a) => a.name === executorAgent)) setExecutorAgent("");
      if (reviewerAgent && !list.find((a) => a.name === reviewerAgent)) setReviewerAgent("");
    }).catch(() => setAgents([]));
  }, []);

  async function submit(e) {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    try {
      const { task } = await api.createTask({
        title: title.trim(),
        description,
        instructions,
        executor_agent: executorAgent || null,
        reviewer_agent: reviewerAgent || null,
      });
      saveRecall(executorAgent || "", reviewerAgent || "");
      onCreated(task);
    } catch (err) {
      pushToast(`Could not create task: ${err.message}`, { variant: "error" });
    } finally { setBusy(false); }
  }

  const agentOptions = agents.map((agent) => ({ value: agent.name, label: agent.display_name || agent.name }));

  return (
    <div class="modal-backdrop" onClick={onClose}>
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="new-task-modal-title" ref={modalRef} onClick={(e) => e.stopPropagation()}>
        <h3 id="new-task-modal-title">New task</h3>
        <form onSubmit={submit}>
          <div class="field span-2">
            <label>Title</label>
            <input autoFocus value={title} onInput={(e) => setTitle(e.target.value)} />
          </div>
          <div class="field span-2">
            <label>Description</label>
            <textarea rows="4" value={description} onInput={(e) => setDescription(e.target.value)} />
          </div>
          <div class="field span-2">
            <label>Instructions</label>
            <textarea rows="5" value={instructions} onInput={(e) => setInstructions(e.target.value)} />
          </div>
          <div class="form-grid">
            <div class="field">
              <label>Executor</label>
              <SelectField
                value={executorAgent}
                options={[{ value: "", label: "Unassigned" }, ...agentOptions]}
                onChange={setExecutorAgent}
              />
            </div>
            <div class="field">
              <label>Reviewer</label>
              <SelectField
                value={reviewerAgent}
                options={[{ value: "", label: "No reviewer" }, ...agentOptions]}
                onChange={setReviewerAgent}
              />
            </div>
          </div>
          <div class="form-actions">
            <button type="submit" class="primary" disabled={busy || !title.trim()}>{busy ? "Creating..." : "Create"}</button>
            <button type="button" onClick={onClose}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}
