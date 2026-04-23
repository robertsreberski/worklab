import { useEffect, useState, useCallback } from "preact/hooks";
import { api } from "../lib/api.js";
import { useSSE } from "../lib/useSSE.js";
import { pushToast } from "../lib/toast.js";
import { TaskCard } from "../components/TaskCard.jsx";
import { NewTaskModal } from "../components/NewTaskModal.jsx";

const COLUMNS = ["todo", "in_progress", "in_review", "done"];
const LABELS = { todo: "To do", in_progress: "In progress", in_review: "In review", done: "Done" };

export function Kanban() {
  const [tasks, setTasks] = useState([]);
  const [showNew, setShowNew] = useState(false);
  const [dragOver, setDragOver] = useState(null);

  const reload = useCallback(() => {
    api.listTasks().then((r) => setTasks(r.tasks));
  }, []);

  useEffect(() => { reload(); }, [reload]);
  useSSE("global", (evt) => {
    if (["task_created", "task_updated", "task_deleted"].includes(evt.type)) reload();
  });

  function onDragStart(e, task) {
    e.dataTransfer.setData("text/task-id", task.id);
    e.dataTransfer.effectAllowed = "move";
  }

  function onDropColumn(e, status) {
    e.preventDefault();
    setDragOver(null);
    const id = e.dataTransfer.getData("text/task-id");
    if (!id) return;
    const task = tasks.find((t) => t.id === id);
    if (!task || task.status === status) return;
    const previous = task.status;
    setTasks((ts) => ts.map((t) => (t.id === id ? { ...t, status } : t)));  // optimistic
    api.patchTask(id, { status }).catch((err) => {
      pushToast(`Move failed (${LABELS[previous]} → ${LABELS[status]}): ${err.message}`, { variant: "error" });
      reload();
    });
  }

  const counts = Object.fromEntries(COLUMNS.map((status) => [
    status,
    tasks.filter((t) => t.status === status).length,
  ]));
  const activeCount = counts.in_progress + counts.in_review;
  const blockedCount = tasks.filter((task) => task.error_text).length;

  return (
    <div class="kanban-page">
      <div class="board-toolbar">
        <div>
          <div class="eyebrow">Task board</div>
          <h2 class="page-title">Agent work queue</h2>
          <div class="board-stats">
            <span class="meta-pill">{tasks.length} total</span>
            <span class="meta-pill">{activeCount} active</span>
            <span class={blockedCount ? "status-badge error" : "status-badge muted"}>
              {blockedCount ? `${blockedCount} blocked` : "No errors"}
            </span>
          </div>
        </div>
        <div class="toolbar">
          <button class="primary" aria-label="+ New task" onClick={() => setShowNew(true)}>New task</button>
          <button onClick={reload}>Refresh</button>
        </div>
      </div>
      <div class="kanban">
        {COLUMNS.map((status) => (
          <div
            key={status}
            class={`column ${dragOver === status ? "drag-over" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(status); }}
            onDragLeave={() => setDragOver((current) => current === status ? null : current)}
            onDrop={(e) => onDropColumn(e, status)}
          >
            <div class="column-header">
              <h3>{LABELS[status]}</h3>
              <span class="column-count">{counts[status]}</span>
            </div>
            {tasks.filter((t) => t.status === status).length === 0 && (
              <div class="column-empty">
                <div>Drop work here.</div>
                {status === "todo" && (
                  <button type="button" class="link-button" onClick={() => setShowNew(true)}>
                    + New task
                  </button>
                )}
              </div>
            )}
            {tasks.filter((t) => t.status === status).map((t) => (
              <TaskCard key={t.id} task={t} onDragStart={onDragStart} />
            ))}
          </div>
        ))}
      </div>
      {showNew && (
        <NewTaskModal
          onClose={() => setShowNew(false)}
          onCreated={() => { setShowNew(false); reload(); }}
        />
      )}
    </div>
  );
}
