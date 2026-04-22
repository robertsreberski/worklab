export function TaskCard({ task, onDragStart }) {
  const cardClass = ["task-card", task.error_text ? "has-error" : ""].filter(Boolean).join(" ");
  const statusLabel = {
    todo: "To do",
    in_progress: "Running",
    in_review: "Review",
    done: "Done",
  }[task.status] || task.status;

  return (
    <a
      class={cardClass}
      href={`#/tasks/${task.id}`}
      draggable
      onDragStart={(e) => onDragStart(e, task)}
    >
      <div class="task-card-top">
        <h4>{task.title}</h4>
        {task.error_text && <span class="status-badge error">Error</span>}
      </div>
      {task.description && <div class="meta">{task.description}</div>}
      <div class="task-card-footer">
        <span class={`status-badge ${task.status}`}>{statusLabel}</span>
        <div class="meta">
          {task.executor_agent ? `Exec ${task.executor_agent}` : "No executor"}
          {task.reviewer_agent ? ` / Rev ${task.reviewer_agent}` : ""}
        </div>
      </div>
    </a>
  );
}
