// src/ui/src/routes/TaskDetail.jsx
import { useEffect, useState, useCallback } from "preact/hooks";
import { api } from "../lib/api.js";
import { useSSE } from "../lib/useSSE.js";
import { useRunStream } from "../lib/useRunStream.js";
import { CommentList } from "../components/CommentList.jsx";
import { EventTimeline } from "../components/EventTimeline.jsx";
import { selectActiveRunId } from "./taskDetailRuns.js";

function RunTimelineCard({ run, title, defaultOpen = false, subscribe = false }) {
  const { events, loading } = useRunStream(run?.id, { subscribe });
  if (!run) return null;
  return (
    <details open={defaultOpen} style="border:1px solid var(--border);border-radius:6px;padding:12px;background:var(--panel);margin-bottom:12px">
      <summary style="cursor:pointer">
        <strong>{title}</strong>
        <span class="meta" style="margin-left:8px">
          {run.mode} · {run.agent_name} · {run.status} · {new Date(run.started_at).toLocaleString()}
          {run.ended_at && ` → ${new Date(run.ended_at).toLocaleString()}`}
        </span>
      </summary>
      <div style="margin-top:12px">
        {loading ? <div class="meta">Loading…</div> : <EventTimeline events={events} />}
      </div>
    </details>
  );
}

export function TaskDetail({ id }) {
  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({});
  const [newComment, setNewComment] = useState("");
  const [activeRunId, setActiveRunId] = useState(null);
  const [runError, setRunError] = useState(null);

  const reload = useCallback(() => {
    api.getTask(id).then(setData).catch(() => setData({ notFound: true }));
  }, [id]);

  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    setActiveRunId(null);
    setRunError(null);
  }, [id]);

  useSSE("global", (evt) => {
    const taskChanged = evt.id === id;
    const runChanged = evt.taskId === id && (evt.type === "run_started" || evt.type === "run_ended");
    if (taskChanged || runChanged) reload();
    if (evt.type === "run_started" && evt.taskId === id) setActiveRunId(evt.runId);
  });

  useEffect(() => {
    const nextRunId = selectActiveRunId(data?.runs || [], activeRunId, {
      preserveMissingActive: Boolean(activeRunId),
    });
    if (nextRunId !== activeRunId) {
      setActiveRunId(nextRunId);
    }
  }, [data, activeRunId]);

  const focusedRun = data?.runs?.find((run) => run.id === activeRunId) || null;
  const historyRuns = data?.runs?.filter((run) => run.id !== activeRunId) || [];
  const activeRunDone = focusedRun ? focusedRun.status !== "running" : false;

  if (!data) return <div>Loading…</div>;
  if (data.notFound) return <div>Task not found. <a href="#/tasks">Back</a></div>;
  const { task, comments, runs } = data;

  async function save() { await api.patchTask(id, draft); setEditing(false); }
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
  async function runNow() {
    setRunError(null);
    try {
      const r = await api.runTask(id);
      setActiveRunId(r.runId);
      reload();
    } catch (err) { setRunError(err.message); }
  }
  async function cancelRun() {
    try { await api.cancelTask(id); } catch (err) { setRunError(err.message); }
  }

  const canRun = task.executor_agent && (task.status === "todo" || task.status === "in_progress") && (!activeRunId || activeRunDone);

  return (
    <div class="detail">
      <a href="#/tasks" class="back-link">← Back</a>
      <h2>{task.title}</h2>
      <div class="meta">
        status: {task.status} · executor: {task.executor_agent || "—"} · reviewer: {task.reviewer_agent || "—"}
      </div>

      <div style="margin:12px 0">
        <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">
          <button class="primary" onClick={runNow} disabled={!canRun}>▶ Run now</button>
          {focusedRun?.status === "running" && <button onClick={cancelRun} style="color:#ff7a7a">Cancel run</button>}
          {runError && <span style="color:#ff7a7a">{runError}</span>}
        </div>
        {!task.executor_agent && <div class="field-help">Set an executor agent to enable Run now.</div>}
      </div>

      {focusedRun && <RunTimelineCard run={focusedRun} title={focusedRun.status === "running" ? "Live run" : "Latest run"} defaultOpen subscribe={focusedRun.status === "running"} />}

      {!editing ? (
        <>
          <p>{task.description || <span class="meta">No description.</span>}</p>
          <h4>Instructions</h4>
          <pre style="white-space:pre-wrap;background:var(--panel-2);padding:10px;border-radius:6px">{task.instructions || "(none)"}</pre>
          <button onClick={() => { setDraft(task); setEditing(true); }}>Edit</button>
          <button onClick={destroy} style="margin-left:8px;color:#ff7a7a">Delete</button>
        </>
      ) : (
        <>
          <div class="field"><label>Title</label><input value={draft.title} onInput={(e) => setDraft({ ...draft, title: e.target.value })} /></div>
          <div class="field"><label>Description</label><textarea rows="4" value={draft.description} onInput={(e) => setDraft({ ...draft, description: e.target.value })} /></div>
          <div class="field"><label>Instructions</label><textarea rows="8" value={draft.instructions} onInput={(e) => setDraft({ ...draft, instructions: e.target.value })} /></div>
          <div class="field"><label>Executor agent</label><input value={draft.executor_agent || ""} placeholder="agent name (slug)" onInput={(e) => setDraft({ ...draft, executor_agent: e.target.value || null })} /></div>
          <div class="field"><label>Reviewer agent</label><input value={draft.reviewer_agent || ""} placeholder="(optional)" onInput={(e) => setDraft({ ...draft, reviewer_agent: e.target.value || null })} /></div>
          <button class="primary" onClick={save}>Save</button>
          <button onClick={() => setEditing(false)} style="margin-left:8px">Cancel</button>
        </>
      )}

      {historyRuns.length > 0 && (
        <>
          <h3 style="margin-top:24px">Previous runs</h3>
          {historyRuns.slice(0, 5).map((run) => (
            <RunTimelineCard key={run.id} run={run} title="Run log" />
          ))}
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
