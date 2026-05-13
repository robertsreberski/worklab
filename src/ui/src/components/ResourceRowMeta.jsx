import { Icon } from "./Icon.jsx";
import { BadgeToken } from "./primitives/BadgeToken.jsx";
import { middleTruncatePath } from "../lib/display.js";

const RESOURCE_ROW_CHIP_TONES = new Set(["muted", "neutral", "info", "accent", "warn", "disabled", "entity"]);

function resourceRowChipTone(tone) {
  return RESOURCE_ROW_CHIP_TONES.has(tone) ? tone : "muted";
}

export function ResourceRowTags({ children, class: className = "" }) {
  return <span class={`resource-row-tags ${className}`.trim()}>{children}</span>;
}

export function ResourceRowId({ children, title }) {
  if (!children) return null;
  return <span class="pane-row-mono" title={title || children}>{children}</span>;
}

export function ResourceRowChip({
  children,
  title,
  class: className = "",
  tone = "muted",
  glyph,
  icon,
  ...props
}) {
  if (!children && children !== 0) return null;
  const chipTone = resourceRowChipTone(tone);
  const leading = icon ? <Icon name={icon} class="resource-row-chip-icon" size={11} /> : null;
  const cls = [
    "resource-row-chip",
    `resource-row-chip-tone-${chipTone}`,
    icon ? "has-icon" : "",
    glyph ? "has-glyph" : "",
    className,
  ].filter(Boolean).join(" ");
  return (
    <BadgeToken
      {...props}
      size="xs"
      class={cls}
      title={title}
      data-tone={chipTone}
      leading={leading}
      glyph={glyph}
    >
      {children}
    </BadgeToken>
  );
}

export function ResourceRowWorktreeChip({ mode }) {
  if (!mode || mode === "off") return null;
  const required = mode === "required";
  const label = required ? "Worktree required" : "Worktree auto";
  return (
    <ResourceRowChip
      tone={required ? "warn" : "accent"}
      icon="git-branch"
      title={required ? "Runs require an isolated Git worktree." : "Runs use an isolated Git worktree when available."}
    >
      {label}
    </ResourceRowChip>
  );
}

export function ResourceRowPath({ value, label = "path", icon = "folder" }) {
  if (!value) return null;
  const displayValue = middleTruncatePath(value, 56);
  return (
    <span class="resource-row-path" title={value} aria-label={`${label} ${value}`}>
      {icon && <Icon name={icon} size={11} />}
      <span class="resource-row-path-label">{label}</span>
      <span class="resource-row-path-value">{displayValue}</span>
    </span>
  );
}
