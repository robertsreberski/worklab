// §4.11 Drawer — right-side 400px full-height panel. Escape closes.
import { useRef } from "preact/hooks";
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
        aria-labelledby={ariaLabelledBy}
      >
        {title && (
          <header class="drawer-head">
            <h2 id={ariaLabelledBy} style={{ margin: 0, fontSize: "var(--text-lg)", fontWeight: 600 }}>{title}</h2>
            <IconButton icon={<Icon name="x" size={14} />} aria-label="Close" onClick={onClose} />
          </header>
        )}
        <div class="drawer-body">{children}</div>
      </aside>
    </>
  );
}
