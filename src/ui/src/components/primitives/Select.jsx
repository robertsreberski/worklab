// §3.6 Select — unified primitive (replaces SelectField + AgentPicker).
// variant: "native" (short lists) | "menu" (searchable, rich rows).
// Trigger is 32px everywhere; menu is --elev-raised with max 320 height.
//
// Props:
//   value, onChange(value), options: Array<Option> | Array<Group>
//   variant, searchable, menuWidth, placeholder, disabled, ariaLabel
//   renderOption(opt), leadingSlot(opt) — host customisation
//
// Option: { value, label, description?, icon?, disabled? }
// Group:  { label, options: Option[] }

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Icon } from "../Icon.jsx";
import { useDropdownPlacement } from "../../hooks/useDropdownPlacement.js";
import { PopoverPortal } from "./PopoverPortal.jsx";

let selectUid = 0;

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

export function Select({
  value,
  onChange,
  options = [],
  variant = "menu",
  searchable,
  menuWidth,
  renderOption,
  leadingSlot,
  placeholder = "Select",
  disabled = false,
  ariaLabel,
  id,
  class: className = "",
}) {
  const autoId = useRef(id || `wl-select-${++selectUid}`);
  const rootRef = useRef(null);
  const menuRef = useRef(null);
  const searchRef = useRef(null);

  const groups = useMemo(() => normaliseGroups(options), [options]);
  const flat = useMemo(() => flattenGroups(groups), [groups]);
  const selected = flat.find((o) => o.value === value) || null;
  const selectedIndex = Math.max(0, flat.findIndex((o) => o.value === value));
  const canSearch = searchable ?? (flat.length > 8);

  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const [filter, setFilter] = useState("");
  const { placement, maxHeight, top, left, width, ready } = useDropdownPlacement(rootRef, menuRef, open);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e) => {
      // Menu lives in a portal, so it's no longer a descendant of rootRef —
      // close only when the click is outside both the trigger and the menu.
      if (rootRef.current?.contains(e.target)) return;
      if (menuRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) {
      setActiveIndex(selectedIndex);
      setFilter("");
    } else if (canSearch) {
      setTimeout(() => searchRef.current?.focus(), 0);
    }
  }, [open, selectedIndex, canSearch]);

  const filteredGroups = useMemo(() => {
    if (!filter) return groups;
    const q = filter.toLowerCase();
    return groups
      .map((g) => ({
        ...g,
        options: (g.options || []).filter((o) => {
          const label = (o.label || o.value || "").toLowerCase();
          const desc = (o.description || "").toLowerCase();
          return label.includes(q) || desc.includes(q);
        }),
      }))
      .filter((g) => g.options.length);
  }, [groups, filter]);

  const filteredFlat = useMemo(() => flattenGroups(filteredGroups), [filteredGroups]);

  function choose(option) {
    if (!option || option.disabled) return;
    onChange?.(option.value);
    setOpen(false);
  }

  function move(delta) {
    const enabled = filteredFlat.map((o, i) => ({ o, i })).filter(({ o }) => !o.disabled);
    if (!enabled.length) return;
    const current = enabled.findIndex(({ i }) => i === activeIndex);
    const next = current < 0 ? 0 : (current + delta + enabled.length) % enabled.length;
    setActiveIndex(enabled[next].i);
  }

  function onKeyDown(event) {
    if (disabled) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) setOpen(true); else move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) setOpen(true); else move(-1);
    } else if (event.key === "Enter" || (event.key === " " && !canSearch)) {
      event.preventDefault();
      if (!open) setOpen(true); else choose(filteredFlat[activeIndex]);
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  }

  // Native variant: short enum, OS control.
  if (variant === "native") {
    const hasEmptyOption = flat.some((o) => o.value === "");
    return (
      <select
        class={`input ${className}`.trim()}
        value={value ?? ""}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(e) => onChange?.(e.target.value)}
      >
        {placeholder && !value && !hasEmptyOption && <option value="" disabled>{placeholder}</option>}
        {flat.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label || o.value}
          </option>
        ))}
      </select>
    );
  }

  const triggerLeading = leadingSlot ? leadingSlot(selected) : (selected?.icon || null);

  return (
    <div
      ref={rootRef}
      class={`select ${open ? "open" : ""} ${className}`.trim()}
      style={menuWidth ? { "--select-menu-width": `${menuWidth}px` } : undefined}
    >
      <button
        type="button"
        class="select-trigger"
        role="combobox"
        aria-controls={`${autoId.current}-listbox`}
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onKeyDown}
      >
        {triggerLeading && <span class="select-trigger-leading">{triggerLeading}</span>}
        <span class={selected ? "select-trigger-label" : "select-trigger-label select-trigger-placeholder"}>
          {selected?.label || selected?.value || placeholder}
        </span>
        <Icon name="chevron-down" size={14} class="select-trigger-chev" />
      </button>
      {open && (
        <PopoverPortal>
        <div
          ref={menuRef}
          class="select-menu"
          id={`${autoId.current}-listbox`}
          role="listbox"
          aria-activedescendant={filteredFlat[activeIndex] ? `${autoId.current}-opt-${activeIndex}` : undefined}
          data-placement={placement}
          style={{
            top: `${top}px`,
            left: `${left}px`,
            width: menuWidth ? `${menuWidth}px` : `${width}px`,
            visibility: ready ? "visible" : "hidden",
            ...(maxHeight != null ? { "--placement-max-height": `${maxHeight}px` } : {}),
          }}
        >
          {canSearch && (
            <div class="select-menu-search">
              <input
                ref={searchRef}
                type="text"
                class="input sm"
                placeholder="Search…"
                value={filter}
                onInput={(e) => { setFilter(e.target.value); setActiveIndex(0); }}
                onKeyDown={onKeyDown}
              />
            </div>
          )}
          {filteredGroups.length === 0 && (
            <div class="select-option select-option-empty" aria-disabled="true">
              No matches
            </div>
          )}
          {filteredGroups.map((group, gi) => (
            <div key={`${group.label}-${gi}`}>
              {group.label && <div class="select-group-label">{group.label}</div>}
              {(group.options || []).map((option) => {
                const index = filteredFlat.indexOf(option);
                const active = index === activeIndex;
                const isSelected = option.value === value;
                const optionLeading = leadingSlot ? leadingSlot(option) : (option.icon || null);
                return (
                  <div
                    key={option.value}
                    id={`${autoId.current}-opt-${index}`}
                    role="option"
                    aria-selected={isSelected}
                    aria-disabled={option.disabled ? "true" : undefined}
                    class={`select-option ${active ? "active" : ""} ${isSelected ? "selected" : ""}`}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => choose(option)}
                  >
                    {renderOption ? renderOption(option, { selected: isSelected, active }) : (
                      <>
                        {optionLeading && <span class="select-option-leading">{optionLeading}</span>}
                        <span class="select-option-body">
                          <span class="select-option-label">{option.label || option.value}</span>
                          {option.description && <span class="select-option-description">{option.description}</span>}
                        </span>
                        {isSelected && <span class="select-option-check"><Icon name="check" size={14} /></span>}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        </PopoverPortal>
      )}
    </div>
  );
}
