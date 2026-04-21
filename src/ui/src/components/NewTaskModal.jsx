import { useState } from "preact/hooks";
import { api } from "../lib/api.js";

export function NewTaskModal({ onClose, onCreated }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    try {
      const { task } = await api.createTask({ title, description });
      onCreated(task);
    } finally { setBusy(false); }
  }

  return (
    <div class="modal-backdrop" onClick={onClose}>
      <div class="modal" onClick={(e) => e.stopPropagation()}>
        <h3>New task</h3>
        <form onSubmit={submit}>
          <div class="field">
            <label>Title</label>
            <input autoFocus value={title} onInput={(e) => setTitle(e.target.value)} />
          </div>
          <div class="field">
            <label>Description</label>
            <textarea rows="4" value={description} onInput={(e) => setDescription(e.target.value)} />
          </div>
          <button type="submit" class="primary" disabled={busy || !title.trim()}>Create</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </form>
      </div>
    </div>
  );
}
