import { AgentAvatar } from "./AgentAvatar.jsx";
import { EntityBadge } from "./EntityBadge.jsx";
import { agentByName, agentHref, agentLabel, splitAgentReferences } from "../lib/agentLinks.js";
import { navigateHash } from "../lib/navigation.js";

function followAgentLink(event, href) {
  event?.stopPropagation?.();
  if (
    event?.defaultPrevented ||
    event?.metaKey ||
    event?.ctrlKey ||
    event?.shiftKey ||
    event?.altKey ||
    event?.button === 1
  ) return;
  event?.preventDefault?.();
  navigateHash(href);
}

export function AgentLink({
  name,
  label,
  agents = [],
  showAvatar = false,
  showLabel = true,
  size = 20,
  compact = false,
  badge = true,
  role,
  title,
  class: className = "",
}) {
  if (!name) return null;
  const agent = agentByName(agents, name);
  const href = agentHref(name);
  const display = label || agentLabel(agent, name);
  const classes = [
    "agent-link",
    showAvatar ? "with-avatar" : "",
    showLabel ? "" : "icon-only",
    className,
  ].filter(Boolean).join(" ");
  if (!showAvatar && showLabel && badge) {
    return (
      <EntityBadge
        kind="agent"
        id={name}
        label={display}
        href={href}
        class={classes}
        title={title || display}
        onClick={(event) => followAgentLink(event, href)}
      />
    );
  }
  return (
    <a
      class={classes}
      href={href}
      title={title || display}
      aria-label={showLabel ? undefined : display}
      onClick={(event) => followAgentLink(event, href)}
    >
      {showAvatar && <AgentAvatar name={name} label={display} size={size} compact={compact} role={role} />}
      {showLabel && <span>{display}</span>}
    </a>
  );
}

export function AgentReferenceText({ text, agents = [] }) {
  const parts = splitAgentReferences(text, agents);
  return (
    <>
      {parts.map((part, index) => (
        typeof part === "string"
          ? part
          : (
            <EntityBadge
              key={`${part.name}-${index}`}
              kind="agent"
              id={part.name}
              label={part.label}
              href={part.href}
              onClick={(event) => followAgentLink(event, part.href)}
            />
          )
      ))}
    </>
  );
}
