// §4.11 Drawer — right-side 400px full-height panel. Escape closes.
import { useId, useRef } from "preact/hooks";
import { useFocusTrap } from "../lib/useFocusTrap.js";
import { IconButton } from "./primitives/IconButton.jsx";
import { Icon } from "./Icon.jsx";

export function Drawer({
  open,
  onClose,
  title,
  children,
  class: className = "",
  ariaLabelledBy,
  width,
  headerActions,
  onResizeStart,
}) {
  const ref = useRef(null);
  const titleId = useId();
  const labelledBy = title ? (ariaLabelledBy || titleId) : undefined;
  useFocusTrap(ref, { active: !!open, onEscape: onClose });
  if (!open) return null;
  const style = width ? { width, maxWidth: "100vw" } : undefined;
  return (
    <>
      <div class="drawer-backdrop" onClick={onClose} />
      <aside
        ref={ref}
        class={`drawer ${className}`.trim()}
        style={style}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
      >
        {onResizeStart && (
          <div
            class="drawer-resize-handle"
            onMouseDown={onResizeStart}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize panel"
          />
        )}
        {title && (
          <header class="drawer-head">
            <h2 id={labelledBy}>{title}</h2>
            <div class="drawer-head-actions">
              {headerActions}
              <IconButton icon={<Icon name="x" size={14} />} aria-label="Close" onClick={onClose} />
            </div>
          </header>
        )}
        <div class="drawer-body">{children}</div>
      </aside>
    </>
  );
}
