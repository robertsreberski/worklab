export function EmptyState({ title, body, cta, icon }) {
  return (
    <div class="empty-state">
      {icon && <div class="empty-state-icon" aria-hidden="true">{icon}</div>}
      {title && <div class="empty-state-title">{title}</div>}
      {body && <div class="empty-state-body">{body}</div>}
      {cta && <div class="empty-state-cta">{cta}</div>}
    </div>
  );
}
