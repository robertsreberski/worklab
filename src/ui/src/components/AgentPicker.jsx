import { useEffect, useRef, useState } from "preact/hooks";
import { Icon } from "./Icon.jsx";
import { AgentAvatar } from "./AgentAvatar.jsx";
import { humanizeSlug } from "../lib/display.js";

export function AgentPicker({
  value,
  onChange,
  agents = [],
  placeholder = "Select agent",
  allowClear = true,
  role,
  class: className = "",
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function onDoc(e) {
      if (!rootRef.current?.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const filtered = agents.filter((a) => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return (a.display_name || a.name || "").toLowerCase().includes(q);
  });

  const selected = agents.find((a) => a.name === value);
  const label = selected
    ? selected.display_name || humanizeSlug(selected.name)
    : placeholder;

  function pick(agent) {
    onChange(agent?.name || null);
    setOpen(false);
    setFilter("");
  }

  return (
    <div class={`agent-picker ${className}`.trim()} ref={rootRef}>
      <button
        type="button"
        class="agent-picker-trigger"
        onClick={() => setOpen((v) => !v)}
      >
        {selected ? (
          <AgentAvatar name={selected.name} label={selected.display_name || selected.name} size={20} />
        ) : (
          <span
            class="agent-avatar unassigned"
            style={{ "--agent-avatar-size": "20px" }}
            aria-hidden="true"
          >
            <span>?</span>
          </span>
        )}
        <span class="picker-label">{label}</span>
        {role && <span class="role">{role}</span>}
        <Icon name="chevron-down" size={13} class="picker-chev" />
      </button>
      {open && (
        <div class="agent-picker-menu">
          <div class="agent-picker-search">
            <input
              type="text"
              placeholder="Filter agents..."
              value={filter}
              onInput={(e) => setFilter(e.target.value)}
              autoFocus
              class="form-input"
            />
          </div>
          {allowClear && value && (
            <div class="agent-picker-option" onClick={() => pick(null)}>
              <span
                class="agent-avatar unassigned"
                style={{ "--agent-avatar-size": "20px" }}
                aria-hidden="true"
              >
                <span>×</span>
              </span>
              <span class="name">Unassigned</span>
            </div>
          )}
          {filtered.length === 0 && (
            <div style={{ padding: 10, color: "var(--muted)", fontSize: 12 }}>No agents match.</div>
          )}
          {filtered.map((a) => (
            <div
              key={a.name}
              class="agent-picker-option"
              aria-selected={a.name === value}
              onClick={() => pick(a)}
            >
              <AgentAvatar name={a.name} label={a.display_name || a.name} size={20} />
              <span class="name">{a.display_name || humanizeSlug(a.name)}</span>
              {!a.enabled && <span class="role">disabled</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
