// §4.10 Modal — blocking action. Backdrop + focus trap + Escape closes.
import { useId, useRef } from "preact/hooks";
import { IconButton } from "./primitives/IconButton.jsx";
import { Icon } from "./Icon.jsx";
import { useFocusTrap } from "../lib/useFocusTrap.js";

export function Modal({
  open,
  onClose,
  title,
  size = "md", // sm | md | lg
  footer,
  children,
  class: className = "",
  closeOnBackdrop = true,
  ariaLabelledBy,
}) {
  const ref = useRef(null);
  const titleId = useId();
  const labelledBy = title ? (ariaLabelledBy || titleId) : undefined;
  useFocusTrap(ref, { active: !!open, onEscape: onClose });

  if (!open) return null;

  return (
    <div
      class="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target.classList.contains("modal-backdrop") && closeOnBackdrop) onClose?.();
      }}
    >
      <div
        ref={ref}
        class={`modal ${size} ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
      >
        {title && (
          <header class="modal-head">
            <h2 id={labelledBy}>{title}</h2>
            <IconButton
              icon={<Icon name="x" size={14} />}
              aria-label="Close"
              onClick={onClose}
            />
          </header>
        )}
        <div class="modal-body">{children}</div>
        {footer && <footer class="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}
