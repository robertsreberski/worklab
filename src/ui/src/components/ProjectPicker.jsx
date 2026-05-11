import { Select } from "./primitives/Select.jsx";
import { Icon } from "./Icon.jsx";

export function projectPickerOptions({
  projects = [],
  value = null,
  allowClear = true,
  clearLabel = "No project",
} = {}) {
  const options = [];
  if (allowClear) {
    options.push({
      value: "",
      label: clearLabel,
      _none: true,
    });
  }
  for (const project of projects) {
    const isArchived = !!project.archived;
    const isCurrent = project.id === value || project.slug === value;
    if (isArchived && !isCurrent) continue;
    options.push({
      value: project.id,
      label: project.name || project.slug || project.id,
      description: [
        project.slug || null,
        isArchived ? "archived" : null,
        project.workdir ? "custom workdir" : null,
        project.worktree_mode && project.worktree_mode !== "off" ? `worktrees ${project.worktree_mode}` : null,
      ].filter(Boolean).join(" · "),
      disabled: isArchived,
      _project: project,
    });
  }
  return options;
}

export function ProjectPicker({
  value,
  onChange,
  projects = [],
  placeholder = "Select project",
  allowClear = true,
  clearLabel = "No project",
  class: className = "",
  ariaLabel,
  disabled = false,
}) {
  const options = projectPickerOptions({ projects, value, allowClear, clearLabel });
  return (
    <Select
      class={className}
      ariaLabel={ariaLabel || placeholder}
      placeholder={placeholder}
      value={value || (allowClear ? "" : undefined)}
      options={options}
      searchable
      disabled={disabled}
      onChange={(nextValue) => {
        if (!nextValue) onChange?.(null);
        else onChange?.(nextValue);
      }}
      leadingSlot={() => (
        <span class="team-picker-icon" aria-hidden="true">
          <Icon name="folder" size={14} />
        </span>
      )}
    />
  );
}
