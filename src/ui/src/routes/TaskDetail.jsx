// src/ui/src/routes/TaskDetail.jsx
import { useEffect, useState, useCallback } from "preact/hooks";
import { api } from "../lib/api.js";
import { useSSE } from "../lib/useSSE.js";
import { useRunStream } from "../lib/useRunStream.js";
import { useFormSave } from "../lib/useFormSave.js";
import { pushToast } from "../lib/toast.js";
import { CommentList } from "../components/CommentList.jsx";
import { EventTimeline } from "../components/EventTimeline.jsx";
import { ConfirmButton } from "../components/ConfirmButton.jsx";
import { SelectField } from "../components/SelectField.jsx";
import { selectActiveRunId } from "./taskDetailRuns.js";

const STATUS_LABELS = {
  todo: "To do",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
};

function RunTimelineCard({ run, title, defaultOpen = false, subscribe = false }) {
  const { events, loading } = useRunStream(run?.id, { subscribe });
  if (!run) return null;
  return (
    <details open={defaultOpen} class="surface-panel run-card">
      <summary>
        <strong>{title}</strong>
        <span class={`status-badge ${run.status === "running" ? "in_progress" : "muted"}`}>{run.status}</span>
        <span class="meta">
          {run.mode} / {run.agent_name} / {new Date(run.started_at).toLocaleString()}
          {run.ended_at && ` / ${new Date(run.ended_at).toLocaleString()}`}
        </span>
      </summary>
      <div class="run-card-body">
        {loading ? <div class="meta">Loading...</div> : <EventTimeline events={events} streaming={run.status === "running"} />}
      </div>
    </details>
  );
}

export function TaskDetail({ id, runParam = null }) {
  const [data, setData] = useState(null);
  const [agents, setAgents] = useState([]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({});
  const [newComment, setNewComment] = useState("");
  const [activeRunId, setActiveRunId] = useState(runParam);
  const [runError, setRunError] = useState(null);
  const [journalSection, setJournalSection] = useState(null);

  const reload = useCallback(() => {
    api.getTask(id).then(setData).catch(() => setData({ notFound: true }));
  }, [id]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    api.listAgents().then((r) => setAgents(r.agents || [])).catch(() => setAgents([]));
  }, []);

  useEffect(() => {
    setActiveRunId(runParam || null);
    setRunError(null);
    setEditing(false);
    setJournalSection(null);
  }, [id, runParam]);

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

  // Fetch the run-scoped journal section when the focused run changes.
  const focusedRunForJournal = data?.runs?.find((run) => run.id === activeRunId) || null;
  useEffect(() => {
    if (!focusedRunForJournal || focusedRunForJournal.status === "running") {
      setJournalSection(null);
      return;
    }
    let cancelled = false;
    api.getAgentJournal(focusedRunForJournal.agent_name, focusedRunForJournal.id)
      .then((r) => { if (!cancelled) setJournalSection(r.section || null); })
      .catch(() => { if (!cancelled) setJournalSection(null); });
    return () => { cancelled = true; };
  }, [focusedRunForJournal?.id, focusedRunForJournal?.status]);

  const focusedRun = data?.runs?.find((run) => run.id === activeRunId) || null;
  const historyRuns = data?.runs?.filter((run) => run.id !== activeRunId) || [];
  const activeRunDone = focusedRun ? focusedRun.status !== "running" : false;

  const formSave = useFormSave(async (patch) => {
    await api.patchTask(id, patch);
    setEditing(false);
    reload();
  });

  if (!data) return <div class="surface-panel">Loading...</div>;
  if (data.notFound) return <div class="surface-panel">Task not found. <a href="#/tasks">Back</a></div>;
  const { task, comments } = data;
  const agentOptions = agents.map((agent) => ({ value: agent.name, label: agent.display_name || agent.name }));

  async function addComment(e) {
    e.preventDefault();
    if (!newComment.trim()) return;
    try {
      await api.addComment(id, newComment.trim());
      setNewComment("");
    } catch (err) {
      pushToast(`Could not post comment: ${err.message}`, { variant: "error" });
    }
  }

  async function destroy() {
    try {
      await api.deleteTask(id);
      window.location.hash = "#/tasks";
    } catch (err) {
      pushToast(`Delete failed: ${err.message}`, { variant: "error" });
    }
  }

  async function runNow() {
    setRunError(null);
    try {
      const r = await api.runTask(id);
      setActiveRunId(r.runId);
      reload();
    } catch (err) {
      setRunError(err.message);
    }
  }

  async function cancelRun() {
    try {
      await api.cancelTask(id);
    } catch (err) {
      setRunError(err.message);
    }
  }

  const canRun = task.executor_agent && (task.status === "todo" || task.status === "in_progress") && (!activeRunId || activeRunDone);

  return (
    <div class="detail task-detail">
      <a href="#/tasks" class="back-link">Back to tasks</a>

      <section class="surface-panel task-hero">
        <div>
          <div class="eyebrow">Task</div>
          <h2>{task.title}</h2>
          <div class="task-meta-grid">
            <span class={`status-badge ${task.status}`}>{STATUS_LABELS[task.status] || task.status}</span>
            <span class="meta-pill">Executor {task.executor_agent || "Unassigned"}</span>
            <span class="meta-pill">Reviewer {task.reviewer_agent || "None"}</span>
            {task.error_text && <span class="status-badge error">Error</span>}
          </div>
        </div>
        <div class="toolbar">
          <button class="primary" onClick={runNow} disabled={!canRun}>Run now</button>
          {focusedRun?.status === "running" && <button onClick={cancelRun} class="danger">Cancel run</button>}
          <button onClick={() => { setDraft(task); setEditing(true); formSave.clearError(); }}>Edit</button>
          <ConfirmButton class="danger" onConfirm={destroy} confirmLabel="Click again to delete">Delete</ConfirmButton>
        </div>
      </section>

      {runError && <div class="surface-panel compact status-line error">{runError}</div>}
      {!task.executor_agent && <div class="surface-panel compact field-help">Set an executor agent to enable Run now.</div>}

      <div class="task-detail-grid">
        <div class="task-main-stack">
          {focusedRun && (
            <RunTimelineCard
              run={focusedRun}
              title={focusedRun.status === "running" ? "Live run" : "Latest run"}
              defaultOpen
              subscribe={focusedRun.status === "running"}
            />
          )}
          {focusedRun && journalSection && (
            <section class="surface-panel run-journal" aria-label="Agent journal for this run">
              <div class="section-kicker">Journal</div>
              <h3 class="section-title">Agent's notes from this run</h3>
              <pre class="code-panel">{journalSection}</pre>
            </section>
          )}

          <section class="surface-panel">
            <div class="list-header">
              <div>
                <div class="section-kicker">Brief</div>
                <h3 class="section-title">Task context</h3>
              </div>
            </div>

            {!editing ? (
              <>
                <div class="field">
                  <label>Description</label>
                  <div class="detail-copy">{task.description || <span class="meta">No description.</span>}</div>
                </div>
                <div class="field">
                  <label>Instructions</label>
                  <pre class="code-panel">{task.instructions || "(none)"}</pre>
                </div>
              </>
            ) : (
              <>
                <div class="form-grid">
                  <div class="field span-2">
                    <label>Title</label>
                    <input value={draft.title} onInput={(e) => setDraft({ ...draft, title: e.target.value })} />
                  </div>
                  <div class="field span-2">
                    <label>Description</label>
                    <textarea rows="4" value={draft.description} onInput={(e) => setDraft({ ...draft, description: e.target.value })} />
                  </div>
                  <div class="field span-2">
                    <label>Instructions</label>
                    <textarea rows="8" value={draft.instructions} onInput={(e) => setDraft({ ...draft, instructions: e.target.value })} />
                  </div>
                  <div class="field">
                    <label>Executor agent</label>
                    <SelectField
                      value={draft.executor_agent || ""}
                      options={[{ value: "", label: "Unassigned" }, ...agentOptions]}
                      onChange={(value) => setDraft({ ...draft, executor_agent: value || null })}
                    />
                  </div>
                  <div class="field">
                    <label>Reviewer agent</label>
                    <SelectField
                      value={draft.reviewer_agent || ""}
                      options={[{ value: "", label: "None" }, ...agentOptions]}
                      onChange={(value) => setDraft({ ...draft, reviewer_agent: value || null })}
                    />
                  </div>
                </div>
                <div class="form-actions">
                  <button class="primary" onClick={() => formSave.save(draft).catch(() => {})} disabled={formSave.saving}>
                    {formSave.saving ? "Saving..." : "Save"}
                  </button>
                  <button onClick={() => { setEditing(false); formSave.clearError(); }} disabled={formSave.saving}>Cancel</button>
                </div>
                {formSave.error && <div class="form-error" role="alert">Save failed: {formSave.error}</div>}
              </>
            )}
          </section>

          {historyRuns.length > 0 && (
            <section class="section-stack">
              <div class="list-header">
                <div>
                  <div class="section-kicker">History</div>
                  <h3 class="section-title">Previous runs</h3>
                </div>
              </div>
              {historyRuns.slice(0, 5).map((run) => (
                <RunTimelineCard key={run.id} run={run} title="Run log" />
              ))}
            </section>
          )}
        </div>

        <aside class="task-side-stack">
          <section class="surface-panel">
            <div class="section-kicker">Workflow</div>
            <h3 class="section-title">Execution state</h3>
            <div class="list-stack">
              <div class="meta-pill">Status {STATUS_LABELS[task.status] || task.status}</div>
              <div class="meta-pill">Executor {task.executor_agent || "Unassigned"}</div>
              <div class="meta-pill">Reviewer {task.reviewer_agent || "None"}</div>
              <div class="meta-pill">Retries {task.retry_count ?? 0}</div>
            </div>
            {task.error_text && <div class="status-line error">{task.error_text}</div>}
          </section>

          <section class="surface-panel">
            <div class="list-header">
              <div>
                <div class="section-kicker">Discussion</div>
                <h3 class="section-title">Comments</h3>
              </div>
            </div>
            <CommentList comments={comments} />
            <form onSubmit={addComment} class="section-stack">
              <div class="field">
                <textarea rows="3" placeholder="Add a comment..." value={newComment} onInput={(e) => setNewComment(e.target.value)} />
              </div>
              <button type="submit" class="primary" disabled={!newComment.trim()}>Post</button>
            </form>
          </section>
        </aside>
      </div>
    </div>
  );
}
