function initials(name) {
  if (!name) return "?";
  const parts = name.replace(/[_-]/g, " ").split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function AgentChip({ role, name }) {
  if (!name) return <span class="agent-chip empty" title={`${role}: unassigned`}>{role}: —</span>;
  return (
    <span class="agent-chip" title={`${role}: ${name}`}>
      <span class="agent-chip-avatar" aria-hidden="true">{initials(name)}</span>
      <span class="agent-chip-name">{name}</span>
    </span>
  );
}

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
      <div class="task-card-agents">
        <AgentChip role="Exec" name={task.executor_agent} />
        {task.reviewer_agent && <AgentChip role="Rev" name={task.reviewer_agent} />}
      </div>
      <div class="task-card-footer">
        <span class={`status-badge ${task.status}`}>{statusLabel}</span>
      </div>
    </a>
  );
}
