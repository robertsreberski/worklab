// §4.12 EmptyState / EmptyStateFiltered — canonical no-data shape.
// 64px icon, 16/600 title, 13/muted body ≤320px, one primary Button.
// §5.12: filtered variant exposes "Clear filters" secondary only.

import { Button } from "./primitives/Button.jsx";

export function EmptyState({ title, body, cta, icon, class: className = "" }) {
  return (
    <div class={`empty-state ${className}`.trim()}>
      {icon && <div class="empty-state-icon" aria-hidden="true">{icon}</div>}
      {title && <div class="empty-state-title">{title}</div>}
      {body && <div class="empty-state-body">{body}</div>}
      {cta && <div class="empty-state-cta">{cta}</div>}
    </div>
  );
}

export function EmptyStateFiltered({
  title = "No matches",
  body = "Nothing matches the current filter.",
  onClearFilters,
  clearLabel = "Clear filters",
  icon,
  class: className = "",
}) {
  return (
    <div class={`empty-state ${className}`.trim()}>
      {icon && <div class="empty-state-icon" aria-hidden="true">{icon}</div>}
      <div class="empty-state-title">{title}</div>
      <div class="empty-state-body">{body}</div>
      {onClearFilters && (
        <div class="empty-state-cta">
          <Button variant="secondary" onClick={onClearFilters}>{clearLabel}</Button>
        </div>
      )}
    </div>
  );
}
