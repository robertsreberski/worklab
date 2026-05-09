// §3.19 Tooltip — floating card with 400ms hover delay.
// Auto-flips above/below based on viewport space; the `placement` prop is
// the preferred side, not a hard requirement.

import { cloneElement } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { useDropdownPlacement } from "../../hooks/useDropdownPlacement.js";
import { PopoverPortal } from "./PopoverPortal.jsx";

let tipUid = 0;
const DELAY = 400;
const FADE = 120;
const OFFSET = 6; // px between trigger edge and tooltip box

export function Tooltip({ label, children, placement = "top" }) {
  const id = useRef(`wl-tooltip-${++tipUid}`);
  const timer = useRef(null);
  const wrapperRef = useRef(null);
  const tooltipRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState(null);

  const { placement: picked } = useDropdownPlacement(wrapperRef, tooltipRef, open, {
    preferred: placement === "bottom" ? "below" : "above",
  });

  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return undefined;
    }
    function recompute() {
      const el = wrapperRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const top = picked === "below" ? rect.bottom + OFFSET : rect.top - OFFSET;
      setCoords({ left: rect.left + rect.width / 2, top });
    }
    recompute();
    function onScroll() { recompute(); }
    window.addEventListener("resize", recompute);
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      window.removeEventListener("resize", recompute);
      window.removeEventListener("scroll", onScroll, { capture: true });
    };
  }, [open, picked]);

  function show() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), DELAY);
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

  const visualPlacement = picked === "below" ? "bottom" : "top";

  return (
    <span ref={wrapperRef} class="tooltip-anchor">
      {enhanced}
      {open && coords && (
        <PopoverPortal>
          <span
            ref={tooltipRef}
            id={id.current}
            role="tooltip"
            class={`tooltip tooltip-${visualPlacement}`}
            style={{ left: `${coords.left}px`, top: `${coords.top}px` }}
          >
            {label}
          </span>
        </PopoverPortal>
      )}
    </span>
  );
}
