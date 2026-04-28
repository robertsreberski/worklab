// §3.17 AgentAvatar — identity-driven avatar.
// Hue derives from stable `agent.name` only (§2.1.5). Never from display_name.
// Role sub-chip (O/R) appears only in task-context views when `role` is set.

function hashHue(value = "") {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash) % 360;
}

function initials(label = "") {
  return String(label || "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] || "")
    .join("")
    .toUpperCase() || "?";
}

export function AgentAvatar({
  name,
  label,
  size = 24,
  title,
  compact = false,
  role, // "owner" | "planner" | "reviewer" | undefined — renders a small role sub-chip.
  class: className = "",
}) {
  const display = label || name || "Unassigned";
  const unassigned = !name;
  const hue = unassigned ? 0 : hashHue(name);
  const style = {
    "--agent-avatar-size": `${size}px`,
    "--agent-avatar-hue": hue,
  };
  return (
    <span
      class={`agent-avatar${compact ? " compact" : ""}${unassigned ? " unassigned" : ""} ${className}`.trim()}
      style={style}
      title={title || display}
      aria-hidden="true"
    >
      <span>{unassigned ? "?" : initials(display)}</span>
      {role && (
        <span class="agent-avatar-role-chip" aria-hidden="true">
          {role === "owner" ? "O" : role === "planner" ? "P" : role === "reviewer" ? "R" : ""}
        </span>
      )}
    </span>
  );
}
