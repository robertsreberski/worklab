import { Icon } from "../Icon.jsx";

export function ExternalAgentBadge({ driver = "", class: className = "" }) {
  return (
    <span class={`external-agent-badge ${className}`.trim()}>
      <Icon name="link" size={11} />
      <span>External{driver ? ` · ${driver}` : ""}</span>
    </span>
  );
}
