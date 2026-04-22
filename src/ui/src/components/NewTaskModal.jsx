import { useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.js";

export function NewTaskModal({ onClose, onCreated }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [executorAgent, setExecutorAgent] = useState("");
  const [reviewerAgent, setReviewerAgent] = useState("");
  const [agents, setAgents] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.listAgents().then((r) => setAgents(r.agents || [])).catch(() => setAgents([]));
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
      onCreated(task);
    } finally { setBusy(false); }
  }

  return (
    <div class="modal-backdrop" onClick={onClose}>
      <div class="modal" onClick={(e) => e.stopPropagation()}>
        <h3>New task</h3>
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
              <select value={executorAgent} onChange={(e) => setExecutorAgent(e.target.value)}>
                <option value="">Unassigned</option>
                {agents.map((agent) => (
                  <option key={agent.name} value={agent.name}>{agent.display_name || agent.name}</option>
                ))}
              </select>
            </div>
            <div class="field">
              <label>Reviewer</label>
              <select value={reviewerAgent} onChange={(e) => setReviewerAgent(e.target.value)}>
                <option value="">No reviewer</option>
                {agents.map((agent) => (
                  <option key={agent.name} value={agent.name}>{agent.display_name || agent.name}</option>
                ))}
              </select>
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
