import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Icon } from "./Icon.jsx";

let selectId = 0;

function normaliseGroups(options = []) {
  const groups = [];
  for (const item of options) {
    if (!item) continue;
    if (Array.isArray(item.options)) {
      groups.push({
        label: item.label || item.group || "",
        options: item.options.map((option) => ({ ...option, group: item.label || item.group || "" })),
      });
    } else {
      groups.push({ label: "", options: [{ ...item, group: item.group || "" }] });
    }
  }
  return groups;
}

function flattenGroups(groups) {
  return groups.flatMap((group) => group.options || []);
}

export function SelectField({
  value,
  options = [],
  onChange,
  placeholder = "Select",
  disabled = false,
  class: className = "",
  ariaLabel,
  id,
}) {
  const autoId = useRef(id || `wl-select-${++selectId}`);
  const rootRef = useRef(null);
  const groups = useMemo(() => normaliseGroups(options), [options]);
  const flatOptions = useMemo(() => flattenGroups(groups), [groups]);
  const selected = flatOptions.find((option) => option.value === value) || null;
  const selectedIndex = Math.max(0, flatOptions.findIndex((option) => option.value === value));
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(selectedIndex);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) setActiveIndex(selectedIndex);
  }, [open, selectedIndex]);

  function choose(option) {
    if (!option || option.disabled) return;
    onChange?.(option.value);
    setOpen(false);
  }

  function move(delta) {
    const enabled = flatOptions.map((option, index) => ({ option, index })).filter(({ option }) => !option.disabled);
    if (!enabled.length) return;
    const current = enabled.findIndex(({ index }) => index === activeIndex);
    const next = current < 0 ? 0 : (current + delta + enabled.length) % enabled.length;
    setActiveIndex(enabled[next].index);
  }

  function onKeyDown(event) {
    if (disabled) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) setOpen(true);
      else move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) setOpen(true);
      else move(-1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!open) setOpen(true);
      else choose(flatOptions[activeIndex]);
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div class={`select-field ${open ? "select-field-open" : ""} ${className}`} ref={rootRef}>
      <button
        type="button"
        class="select-field-button"
        role="combobox"
        aria-controls={`${autoId.current}-listbox`}
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={onKeyDown}
      >
        <span class={selected ? "select-field-value" : "select-field-placeholder"}>
          {selected?.label || selected?.value || placeholder}
        </span>
        <Icon name="chevron-down" size={14} class={`select-field-chevron ${open ? "open" : ""}`} />
      </button>
      {open && (
        <div class="select-field-menu" id={`${autoId.current}-listbox`} role="listbox">
          {groups.map((group, groupIndex) => (
            <div class="select-field-group" key={`${group.label}-${groupIndex}`}>
              {group.label && <div class="select-field-group-label">{group.label}</div>}
              {(group.options || []).map((option) => {
                const index = flatOptions.indexOf(option);
                const active = index === activeIndex;
                const selectedOption = option.value === value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={selectedOption}
                    disabled={option.disabled}
                    class={`select-field-option ${active ? "active" : ""} ${selectedOption ? "selected" : ""}`}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => choose(option)}
                  >
                    <span>
                      <span class="select-field-option-label">{option.label || option.value}</span>
                      {option.description && <span class="select-field-option-description">{option.description}</span>}
                    </span>
                    {selectedOption && <Icon name="check" size={14} strokeWidth={2.2} />}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
