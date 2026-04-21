// src/ui/src/routes/TaskDetail.jsx
import { useEffect, useState, useCallback } from "preact/hooks";
import { api } from "../lib/api.js";
import { useSSE } from "../lib/useSSE.js";
import { CommentList } from "../components/CommentList.jsx";

export function TaskDetail({ id }) {
  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({});
  const [newComment, setNewComment] = useState("");

  const reload = useCallback(() => {
    api.getTask(id).then(setData).catch(() => setData({ notFound: true }));
  }, [id]);

  useEffect(() => { reload(); }, [reload]);
  useSSE("global", (evt) => { if (evt.id === id) reload(); });

  if (!data) return <div>Loading…</div>;
  if (data.notFound) return <div>Task not found. <a href="#/tasks">Back</a></div>;

  const { task, comments } = data;

  async function save() {
    await api.patchTask(id, draft);
    setEditing(false);
  }

  async function addComment(e) {
    e.preventDefault();
    if (!newComment.trim()) return;
    await api.addComment(id, newComment.trim());
    setNewComment("");
  }

  async function destroy() {
    if (!confirm("Delete this task?")) return;
    await api.deleteTask(id);
    window.location.hash = "#/tasks";
  }

  return (
    <div class="detail">
      <a href="#/tasks">← Back</a>
      <h2>{task.title}</h2>
      <div class="meta">
        status: {task.status} · created {new Date(task.created_at).toLocaleString()}
      </div>

      {!editing && (
        <>
          <p>{task.description || <span class="meta">No description.</span>}</p>
          <h4>Instructions</h4>
          <pre style="white-space:pre-wrap;background:var(--panel-2);padding:10px;border-radius:6px">{task.instructions || "(none)"}</pre>
          <button onClick={() => { setDraft(task); setEditing(true); }}>Edit</button>
          <button onClick={destroy} style="margin-left:8px;color:#ff7a7a">Delete</button>
        </>
      )}

      {editing && (
        <>
          <div class="field"><label>Title</label><input value={draft.title} onInput={(e) => setDraft({ ...draft, title: e.target.value })} /></div>
          <div class="field"><label>Description</label><textarea rows="4" value={draft.description} onInput={(e) => setDraft({ ...draft, description: e.target.value })} /></div>
          <div class="field"><label>Instructions</label><textarea rows="8" value={draft.instructions} onInput={(e) => setDraft({ ...draft, instructions: e.target.value })} /></div>
          <button class="primary" onClick={save}>Save</button>
          <button onClick={() => setEditing(false)} style="margin-left:8px">Cancel</button>
        </>
      )}

      <h3 style="margin-top:24px">Comments</h3>
      <CommentList comments={comments} />
      <form onSubmit={addComment} style="margin-top:12px">
        <div class="field"><textarea rows="3" placeholder="Add a comment…" value={newComment} onInput={(e) => setNewComment(e.target.value)} /></div>
        <button type="submit" class="primary" disabled={!newComment.trim()}>Post</button>
      </form>
    </div>
  );
}
