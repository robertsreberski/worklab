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
  class: className = "",
}) {
  const display = label || name || "Unassigned";
  const hue = hashHue(name || display);
  const style = {
    "--agent-avatar-size": `${size}px`,
    "--agent-avatar-hue": hue,
  };
  return (
    <span
      class={`agent-avatar${compact ? " compact" : ""} ${className}`.trim()}
      style={style}
      title={title || display}
      aria-hidden="true"
    >
      <span>{initials(display)}</span>
    </span>
  );
}
