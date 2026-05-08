import { createPortal } from "preact/compat";
import { useRef } from "preact/hooks";
import { Icon } from "./Icon.jsx";
import { IconButton } from "./primitives/IconButton.jsx";
import { useFocusTrap } from "../lib/useFocusTrap.js";

export function MobileConfigTrigger({
  label = "Configuration",
  activeCount = 0,
  controls,
  expanded = false,
  class: className = "",
  onClick,
}) {
  return (
    <IconButton
      icon={<Icon name="more-horizontal" size={17} />}
      class={`mobile-config-trigger ${className}`.trim()}
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={controls ? (expanded ? "true" : "false") : undefined}
      aria-controls={controls}
      onClick={onClick}
    >
      {activeCount > 0 && <span class="mobile-config-count">{activeCount}</span>}
    </IconButton>
  );
}

export function MobileConfigSheet({
  id,
  title = "Configuration",
  open = false,
  onClose,
  children,
  class: className = "",
  bodyClass = "",
}) {
  const panelRef = useRef(null);
  useFocusTrap(panelRef, { active: open, onEscape: onClose });

  const sheet = (
    <div id={id} class={`mobile-config-sheet ${open ? "open" : ""} ${className}`.trim()}>
      <button type="button" class="mobile-config-sheet-scrim" aria-label="Close configuration" onClick={onClose} />
      <div
        ref={panelRef}
        class="mobile-config-sheet-panel"
        role={open ? "dialog" : undefined}
        aria-modal={open ? "true" : undefined}
        aria-label={open ? title : undefined}
      >
        <span class="mobile-config-sheet-grabber" aria-hidden="true" />
        <header class="mobile-config-sheet-head">
          <h2>{title}</h2>
          <IconButton
            icon={<Icon name="x" size={16} />}
            class="mobile-config-sheet-close"
            aria-label="Close"
            onClick={onClose}
          />
        </header>
        <div class={`mobile-config-sheet-body ${bodyClass}`.trim()}>{children}</div>
      </div>
    </div>
  );

  if (open && typeof document !== "undefined") return createPortal(sheet, document.body);
  return sheet;
}
