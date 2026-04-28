// AgentPicker — compat wrapper that composes the unified Select (§3.6) with an
// agent-specific leading slot (AgentAvatar + role). Keeps prior call-site API.
import { Select } from "./primitives/Select.jsx";
import { AgentAvatar } from "./AgentAvatar.jsx";
import { agentModelEffortLabel, humanizeSlug } from "../lib/display.js";

function normalizeRoleForAvatar(role) {
  const normalized = String(role || "").trim().toLowerCase();
  if (normalized === "owner" || normalized === "planner" || normalized === "reviewer") return normalized;
  return undefined;
}

export function AgentPicker({
  value,
  onChange,
  agents = [],
  placeholder = "Select agent",
  allowClear = true,
  role,
  class: className = "",
  ariaLabel,
}) {
  const options = [];
  if (allowClear) {
    options.push({
      value: "__unassigned__",
      label: "Unassigned",
      _unassigned: true,
    });
  }
  for (const a of agents) {
    const metadata = agentModelEffortLabel(a);
    options.push({
      value: a.name,
      label: a.display_name || humanizeSlug(a.name),
      description: [
        a.enabled === false ? "disabled" : null,
        metadata || null,
      ].filter(Boolean).join(" · ") || undefined,
      _agent: a,
    });
  }

  const unassignedAvatar = (
    <span class="agent-avatar unassigned agent-avatar-sm" aria-hidden="true">
      <span>?</span>
    </span>
  );
  const avatarRole = normalizeRoleForAvatar(role);

  return (
    <Select
      class={className}
      ariaLabel={ariaLabel || placeholder}
      placeholder={placeholder}
      value={value || (allowClear ? "__unassigned__" : undefined)}
      options={options}
      onChange={(val) => {
        if (val === "__unassigned__" || !val) onChange?.(null);
        else onChange?.(val);
      }}
      leadingSlot={(opt) => {
        if (!opt || opt._unassigned) return unassignedAvatar;
        if (opt._agent) {
          return (
            <AgentAvatar
              name={opt._agent.name}
              label={opt._agent.display_name || opt._agent.name}
              role={avatarRole}
              size={20}
            />
          );
        }
        return null;
      }}
    />
  );
}
