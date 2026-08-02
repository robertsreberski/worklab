// AgentPicker — compat wrapper that composes the unified Select (§3.6) with an
// agent-specific leading slot (AgentAvatar + role). Keeps prior call-site API.
import { Select } from "./primitives/Select.jsx";
import { AgentAvatar } from "./AgentAvatar.jsx";
import { agentModelEffortLabel, humanizeSlug } from "../lib/display.js";
import { externalAgentKind } from "../lib/externalAgents.js";

function normalizeRoleForAvatar(role) {
  const normalized = String(role || "").trim().toLowerCase();
  if (normalized === "owner" || normalized === "planner" || normalized === "reviewer") return normalized;
  return undefined;
}

function eligibilityEntry(source, name, agent) {
  if (source instanceof Map) return source.get(name);
  if (typeof source === "function") return source(agent);
  return source?.[name];
}

export function agentAssignmentEligibility(agent, eligibility = null, disabledReasons = null) {
  const name = agent?.name;
  const supplied = eligibilityEntry(eligibility, name, agent);
  const suppliedReason = eligibilityEntry(disabledReasons, name, agent);
  const directEligible = agent?.assignment_eligible ?? agent?.assignmentEligible;
  const directReason = agent?.assignment_disabled_reason ?? agent?.assignmentDisabledReason;
  const entry = supplied ?? (directEligible === undefined && !directReason ? null : { eligible: directEligible, reason: directReason });
  const reason = typeof suppliedReason === "string"
    ? suppliedReason
    : typeof entry === "string"
      ? entry
      : entry?.reason || entry?.disabledReason || entry?.disabled_reason || directReason || "";
  const eligible = typeof entry === "boolean"
    ? entry
    : entry && typeof entry === "object"
      ? entry.eligible !== false && entry.disabled !== true
      : !reason;
  return { eligible, reason: reason || (eligible ? "" : "Unavailable for this assignment") };
}

function pickerOption(agent, value, eligibility, disabledReasons) {
  const isDisabled = agent.enabled === false;
  const assignment = agentAssignmentEligibility(agent, eligibility, disabledReasons);
  if (isDisabled && agent.name !== value) return null;
  const kind = externalAgentKind(agent);
  const metadata = kind === "external"
    ? ["ACP", agent.driver || agent.external_driver].filter(Boolean).join(" · ")
    : agentModelEffortLabel(agent);
  return {
    value: agent.name,
    label: agent.display_name || humanizeSlug(agent.name),
    description: [
      isDisabled ? "disabled" : null,
      !assignment.eligible ? assignment.reason : null,
      metadata || null,
    ].filter(Boolean).join(" · ") || undefined,
    disabled: isDisabled || !assignment.eligible,
    _agent: agent,
  };
}

export function agentPickerOptions({ agents = [], value = null, allowClear = true, eligibility = null, disabledReasons = null } = {}) {
  const options = [];
  if (allowClear) {
    options.push({
      value: "__unassigned__",
      label: "Unassigned",
      _unassigned: true,
    });
  }
  for (const [kind, label] of [["local", "Local agents"], ["external", "External agents"]]) {
    const grouped = agents
      .filter((agent) => externalAgentKind(agent) === kind)
      .map((agent) => pickerOption(agent, value, eligibility, disabledReasons))
      .filter(Boolean);
    if (grouped.length) options.push({ label, options: grouped });
  }
  return options;
}

export function AgentPicker({
  value,
  onChange,
  agents = [],
  placeholder = "Select agent",
  allowClear = true,
  role,
  eligibility = null,
  disabledReasons = null,
  class: className = "",
  ariaLabel,
}) {
  const options = agentPickerOptions({ agents, value, allowClear, eligibility, disabledReasons });

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
