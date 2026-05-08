// §4.20 Banner — inline contextual message (warn / error / info).
// Dismissible. warn/info use role=status; error uses role=alert.

import { IconButton } from "./primitives/IconButton.jsx";
import { Icon } from "./Icon.jsx";
import { Toolbar } from "./layout/index.js";

const ICONS = {
  warn: "alert-triangle",
  error: "x-circle",
  info: "info",
};

export function Banner({
  variant = "info",
  title,
  detail,
  actions,
  onDismiss,
  dismissible = true,
  class: className = "",
  children,
}) {
  const role = variant === "error" ? "alert" : "status";
  return (
    <div class={`banner ${variant} ${className}`.trim()} role={role}>
      <span class="banner-icon" aria-hidden="true">
        <Icon name={ICONS[variant] || "info"} size={16} />
      </span>
      <div class="banner-body">
        {title && <div class="banner-title">{title}</div>}
        {detail && <div class="banner-detail">{detail}</div>}
        {children}
      </div>
      {(actions || (dismissible && onDismiss)) && (
        <Toolbar class="banner-actions">
          {actions}
          {dismissible && onDismiss && (
            <IconButton
              icon={<Icon name="x" size={14} />}
              aria-label="Dismiss"
              onClick={onDismiss}
            />
          )}
        </Toolbar>
      )}
    </div>
  );
}
