// §5.1 StatusMenu — hangs off the StatusPill on TaskDetail.
// Exposes only the transitions in the §5.1 table for the current state.
// Disabled transitions are hidden (not greyed-out) to reduce cognitive load.

import { useEffect, useId, useMemo, useRef, useState } from "preact/hooks";
import { statusMeta } from "./primitives/StatusPill.jsx";
import { StageToken } from "./primitives/StageToken.jsx";
import { useDropdownPlacement } from "../hooks/useDropdownPlacement.js";
import { PopoverPortal } from "./primitives/PopoverPortal.jsx";

// Per §5.1 table. Each entry is { from, to, label, confirm?: string }.
// confirm is the modal message string (caller wires the Modal).
const TRANSITIONS = [
  { from: "plan",              to: "execute",     label: "Start work" },
  { from: "execute",           to: "done",        label: "Mark done", confirm: "Mark done without a run or review?" },
  { from: "review",            to: "done",        label: "Approve" },
  { from: "review",            to: "execute",     label: "Request changes" },
  { from: "awaiting_children", to: "execute",     label: "Resume manually", confirm: "Resume before all children are done?" },
  { from: "awaiting_user",     to: "execute",     label: "Resume" },
  { from: "blocked",           to: "execute",     label: "Retry" },
  { from: "done",              to: "execute",     label: "Reopen" },
];

export function allowedTransitions(status) {
  return TRANSITIONS.filter((t) => t.from === status);
}

export function StatusMenu({
  status,
  displayStage = status,
  pulse = false,
  onChoose,
  class: className = "",
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const ref = useRef(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const listId = useId();
  const choices = useMemo(() => allowedTransitions(status), [status]);
  const { placement, maxHeight, top, left, ready } = useDropdownPlacement(ref, menuRef, open);

  useEffect(() => {
    if (!open) return;
    const close = (e) => {
      if (ref.current?.contains(e.target)) return;
      if (menuRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    const onKey = (e) => { if (e.key === "Escape") { setOpen(false); triggerRef.current?.focus(); } };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [status, open]);

  function choose(index) {
    const transition = choices[index];
    if (!transition) return;
    setOpen(false);
    onChoose?.(transition);
    triggerRef.current?.focus();
  }

  function move(delta) {
    if (!choices.length) return;
    setActiveIndex((current) => (current + delta + choices.length) % choices.length);
  }

  function onTriggerKeyDown(event) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) setOpen(true);
      else move(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) setOpen(true);
      else move(-1);
      return;
    }
    if (event.key === "Home" && open) {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (event.key === "End" && open) {
      event.preventDefault();
      setActiveIndex(Math.max(choices.length - 1, 0));
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!open) setOpen(true);
      else choose(activeIndex);
    }
  }

  return (
    <div ref={ref} class={`status-menu ${className}`.trim()}>
      <button
        ref={triggerRef}
        type="button"
        class="status-menu-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={listId}
        aria-activedescendant={open && choices[activeIndex] ? `${listId}-opt-${activeIndex}` : undefined}
        role="combobox"
        onKeyDown={onTriggerKeyDown}
      >
        <StageToken stage={displayStage} variant="menu" pulse={pulse} as="span" />
      </button>
      {open && choices.length > 0 && (
        <PopoverPortal>
        <div
          ref={menuRef}
          class="select-menu status-menu-list"
          id={listId}
          role="listbox"
          data-placement={placement}
          style={{
            top: `${top}px`,
            left: `${left}px`,
            visibility: ready ? "visible" : "hidden",
            ...(maxHeight != null ? { "--placement-max-height": `${maxHeight}px` } : {}),
          }}
        >
          {choices.map((t, index) => {
            const meta = statusMeta(t.to);
            return (
              <div
                key={`${t.from}-${t.to}`}
                id={`${listId}-opt-${index}`}
                class="select-option status-menu-option"
                role="option"
                aria-selected={index === activeIndex}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => choose(index)}
              >
                <span class="status-dot" style={{ "--dot-color": meta.color, "--dot-size": "8px" }} />
                <span class="select-option-body">
                  <span class="select-option-label">{t.label}</span>
                  <span class="select-option-description">→ {meta.label}</span>
                </span>
              </div>
            );
          })}
        </div>
        </PopoverPortal>
      )}
    </div>
  );
}
