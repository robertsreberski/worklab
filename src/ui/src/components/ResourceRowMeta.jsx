import { Icon } from "./Icon.jsx";
import { BadgeToken } from "./primitives/BadgeToken.jsx";

export function ResourceRowTags({ children, class: className = "" }) {
  return <span class={`resource-row-tags ${className}`.trim()}>{children}</span>;
}

export function ResourceRowId({ children, title }) {
  if (!children) return null;
  return <span class="pane-row-mono" title={title || children}>{children}</span>;
}

export function ResourceRowChip({ children, title, class: className = "", ...props }) {
  if (!children && children !== 0) return null;
  return <BadgeToken {...props} size="xs" class={`resource-row-chip ${className}`.trim()} title={title}>{children}</BadgeToken>;
}

export function ResourceRowPath({ value, label = "path", icon = "folder" }) {
  if (!value) return null;
  return (
    <span class="resource-row-path" title={value} aria-label={`${label} ${value}`}>
      {icon && <Icon name={icon} size={11} />}
      <span class="resource-row-path-label">{label}</span>
      <span class="resource-row-path-value">{value}</span>
    </span>
  );
}
