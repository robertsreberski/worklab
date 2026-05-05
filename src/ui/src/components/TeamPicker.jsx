import { Select } from "./primitives/Select.jsx";
import { Icon } from "./Icon.jsx";

function memberCountLabel(count) {
  const value = Number(count || 0);
  return `${value} member${value === 1 ? "" : "s"}`;
}

export function teamPickerOptions({
  teams = [],
  value = null,
  allowClear = true,
  clearLabel = "Project default",
} = {}) {
  const options = [];
  if (allowClear) {
    options.push({
      value: "__none__",
      label: clearLabel,
      _none: true,
    });
  }
  for (const team of teams) {
    const isArchived = team.status === "archived";
    if (isArchived && team.id !== value) continue;
    options.push({
      value: team.id,
      label: team.name || team.slug || team.id,
      description: [
        team.slug || null,
        memberCountLabel(team.member_count),
        isArchived ? "archived" : null,
      ].filter(Boolean).join(" · "),
      disabled: isArchived,
      _team: team,
    });
  }
  return options;
}

export function TeamPicker({
  value,
  onChange,
  teams = [],
  placeholder = "Select team",
  allowClear = true,
  clearLabel = "Project default",
  class: className = "",
  ariaLabel,
}) {
  const options = teamPickerOptions({ teams, value, allowClear, clearLabel });
  return (
    <Select
      class={className}
      ariaLabel={ariaLabel || placeholder}
      placeholder={placeholder}
      value={value || (allowClear ? "__none__" : undefined)}
      options={options}
      searchable
      onChange={(nextValue) => {
        if (nextValue === "__none__" || !nextValue) onChange?.(null);
        else onChange?.(nextValue);
      }}
      leadingSlot={(option) => (
        <span class="team-picker-icon" aria-hidden="true">
          <Icon name="users" size={14} />
        </span>
      )}
    />
  );
}
