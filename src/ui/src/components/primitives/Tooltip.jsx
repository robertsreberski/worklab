// §3.19 Tooltip — floating card with 400ms hover delay.
// Minimal implementation: positions below trigger, dismisses on mouseleave / Escape.

import { cloneElement } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

let tipUid = 0;
const DELAY = 400;
const FADE = 120;
const OFFSET = 6; // px between trigger edge and tooltip box

export function Tooltip({ label, children, placement = "top" }) {
  const id = useRef(`wl-tooltip-${++tipUid}`);
  const timer = useRef(null);
  const wrapperRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState({ left: 0, top: 0 });

  function position() {
    const el = wrapperRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const top = placement === "bottom"
      ? rect.bottom + OFFSET
      : rect.top - OFFSET;
    setCoords({
      left: rect.left + rect.width / 2,
      top,
    });
  }

  function show() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { position(); setOpen(true); }, DELAY);
  }
  function hide() {
    if (timer.current) clearTimeout(timer.current);
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") hide(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  if (!label) return children;

  const child = Array.isArray(children) ? children[0] : children;
  const enhanced = child && typeof child === "object" && child.type
    ? cloneElement(child, {
        "aria-describedby": open ? id.current : undefined,
        onMouseEnter: show,
        onMouseLeave: hide,
        onFocus: show,
        onBlur: hide,
      })
    : child;

  return (
    <span ref={wrapperRef} class="tooltip-anchor">
      {enhanced}
      {open && (
        <span
          id={id.current}
          role="tooltip"
          class={`tooltip tooltip-${placement}`}
          style={{ left: `${coords.left}px`, top: `${coords.top}px` }}
        >
          {label}
        </span>
      )}
    </span>
  );
}
