import { Icon } from "../Icon.jsx";
import { Breadcrumb } from "../primitives/Breadcrumb.jsx";
import { IconButton } from "../primitives/IconButton.jsx";
import { Kbd } from "../primitives/Kbd.jsx";
import { Toolbar } from "./Page.jsx";

export function EditHeader({
  ariaLabel,
  backLabel = "Back",
  onBack,
  breadcrumbs = [],
  kicker,
  title,
  meta,
  icon,
  iconFrame = true,
  iconClass = "",
  actions,
  shortcut = true,
  class: className = "",
}) {
  const hasTitle = !!(kicker || title || meta || icon);
  return (
    <header
      class={`task-edit-head pane-detail-head ds-detail-head edit-shell-head ${hasTitle ? "has-title" : "is-plain"} ${className}`.trim()}
      aria-label={ariaLabel || title || backLabel}
    >
      <div class="task-edit-head-left edit-shell-head-left">
        {onBack && (
          <IconButton
            icon={<Icon name="chevron-left" size={14} />}
            aria-label={backLabel}
            onClick={onBack}
          />
        )}
        <div class="edit-shell-copy">
          {breadcrumbs.length > 0 && <Breadcrumb items={breadcrumbs} />}
          {hasTitle && (
            <div class="edit-shell-title-row">
              {icon && (
                iconFrame
                  ? <div class={`pane-detail-icon ds-detail-icon ${iconClass}`.trim()} aria-hidden="true">{icon}</div>
                  : <div class="ds-detail-identity edit-shell-identity" aria-hidden="true">{icon}</div>
              )}
              <div class="pane-detail-head-titles edit-shell-titles">
                {kicker && <span class="form-section-kicker">{kicker}</span>}
                {title && <h2>{title}</h2>}
                {meta && <div class="pane-detail-subline">{meta}</div>}
              </div>
            </div>
          )}
        </div>
      </div>
      {actions && (
        <Toolbar class="task-edit-toolbar edit-shell-toolbar">
          {shortcut && (
            <span class="task-edit-shortcut" aria-hidden="true">
              <Kbd>⌘</Kbd><Kbd>S</Kbd> save
            </span>
          )}
          {actions}
        </Toolbar>
      )}
    </header>
  );
}
