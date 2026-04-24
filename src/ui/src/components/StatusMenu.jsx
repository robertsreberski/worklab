// §5.1 StatusMenu — hangs off the StatusPill on TaskDetail.
// Exposes only the transitions in the §5.1 table for the current state.
// Disabled transitions are hidden (not greyed-out) to reduce cognitive load.

import { useEffect, useRef, useState } from "preact/hooks";
import { StatusPill, statusMeta } from "./primitives/StatusPill.jsx";
import { Icon } from "./Icon.jsx";

// Per §5.1 table. Each entry is { from, to, label, confirm?: string }.
// confirm is the modal message string (caller wires the Modal).
const TRANSITIONS = [
  { from: "todo",         to: "in_progress", label: "Run now" },
  { from: "todo",         to: "done",        label: "Mark done" },
  { from: "in_progress",  to: "todo",        label: "Reset to todo", confirm: "Reset to todo? Active run will be cancelled." },
  { from: "in_progress",  to: "done",        label: "Mark done",     confirm: "Mark done without review?" },
  { from: "in_review",    to: "in_progress", label: "Send back" },
  { from: "in_review",    to: "done",        label: "Approve" },
  { from: "in_review",    to: "todo",        label: "Reset to todo", confirm: "Reset to todo? Current review will be discarded." },
  { from: "done",         to: "todo",        label: "Reopen" },
];

export function allowedTransitions(status) {
  return TRANSITIONS.filter((t) => t.from === status);
}

export function StatusMenu({
  status,
  onChoose,
  class: className = "",
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const choices = allowedTransitions(status);

  return (
    <div ref={ref} class={`status-menu ${className}`.trim()} style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        style={{ background: "transparent", border: 0, padding: 0, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: "var(--sp-1)" }}
      >
        <StatusPill status={status} />
        <Icon name="chevron-down" size={12} />
      </button>
      {open && choices.length > 0 && (
        <div
          class="select-menu"
          role="menu"
          style={{ right: "auto", left: 0, minWidth: 200, top: "calc(100% + var(--sp-1))" }}
        >
          {choices.map((t) => {
            const meta = statusMeta(t.to);
            return (
              <button
                key={`${t.from}-${t.to}`}
                type="button"
                class="select-option"
                role="menuitem"
                style={{ width: "100%", textAlign: "left", border: 0, background: "transparent", font: "inherit", cursor: "pointer" }}
                onClick={() => {
                  setOpen(false);
                  onChoose?.(t);
                }}
              >
                <span class="status-dot" style={{ "--dot-color": meta.color, "--dot-size": "8px" }} />
                <span class="select-option-body">
                  <span class="select-option-label">{t.label}</span>
                  <span class="select-option-description">→ {meta.label}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
