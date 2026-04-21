import { useEffect, useState, useCallback } from "preact/hooks";
import { api } from "../lib/api.js";
import { useSSE } from "../lib/useSSE.js";
import { TaskCard } from "../components/TaskCard.jsx";
import { NewTaskModal } from "../components/NewTaskModal.jsx";

const COLUMNS = ["todo", "in_progress", "in_review", "done"];
const LABELS = { todo: "To do", in_progress: "In progress", in_review: "In review", done: "Done" };

export function Kanban() {
  const [tasks, setTasks] = useState([]);
  const [showNew, setShowNew] = useState(false);

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
    const id = e.dataTransfer.getData("text/task-id");
    if (!id) return;
    const task = tasks.find((t) => t.id === id);
    if (!task || task.status === status) return;
    setTasks((ts) => ts.map((t) => (t.id === id ? { ...t, status } : t)));  // optimistic
    api.patchTask(id, { status }).catch(() => reload());
  }

  return (
    <>
      <div style="margin-bottom:12px">
        <button class="primary" onClick={() => setShowNew(true)}>+ New task</button>
      </div>
      <div class="kanban">
        {COLUMNS.map((status) => (
          <div
            key={status}
            class="column"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => onDropColumn(e, status)}
          >
            <h3>{LABELS[status]}</h3>
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
    </>
  );
}
