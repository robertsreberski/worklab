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
}) {
  const ref = useRef(null);
  const titleId = useId();
  const labelledBy = title ? (ariaLabelledBy || titleId) : undefined;
  useFocusTrap(ref, { active: !!open, onEscape: onClose });
  if (!open) return null;
  return (
    <>
      <div class="drawer-backdrop" onClick={onClose} />
      <aside
        ref={ref}
        class={`drawer ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
      >
        {title && (
          <header class="drawer-head">
            <h2 id={labelledBy}>{title}</h2>
            <IconButton icon={<Icon name="x" size={14} />} aria-label="Close" onClick={onClose} />
          </header>
        )}
        <div class="drawer-body">{children}</div>
      </aside>
    </>
  );
}
