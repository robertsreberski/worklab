export function TaskCard({ task, onDragStart }) {
  return (
    <a
      class="task-card"
      href={`#/tasks/${task.id}`}
      draggable
      onDragStart={(e) => onDragStart(e, task)}
    >
      <h4>{task.title}</h4>
      <div class="meta">
        {task.executor_agent ? `exec: ${task.executor_agent}` : "no executor"}
        {task.reviewer_agent ? ` · rev: ${task.reviewer_agent}` : ""}
      </div>
    </a>
  );
}
