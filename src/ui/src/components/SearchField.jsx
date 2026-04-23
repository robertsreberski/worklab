import { useEffect, useId, useRef } from "preact/hooks";
import { Icon } from "./Icon.jsx";

export function SearchField({
  value,
  onInput,
  placeholder = "Search",
  shortcut,
  class: className = "",
  inputClass = "",
  autoFocus = false,
}) {
  const inputRef = useRef(null);
  const inputId = useId();

  useEffect(() => {
    if (!shortcut) return undefined;
    const normalized = shortcut.toLowerCase();
    function onKeyDown(event) {
      const target = event.target;
      const tagName = target?.tagName?.toLowerCase?.() || "";
      const editable = target?.isContentEditable || tagName === "input" || tagName === "textarea" || tagName === "select";
      if (editable || event.metaKey || event.ctrlKey || event.altKey) return;
      if (String(event.key || "").toLowerCase() !== normalized) return;
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select?.();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [shortcut]);

  return (
    <label class={`search-field ${className}`.trim()} for={inputId}>
      <Icon name="search" size={14} class="search-field-icon" />
      <input
        id={inputId}
        ref={inputRef}
        class={`search-field-input ${inputClass}`.trim()}
        type="search"
        value={value}
        onInput={onInput}
        placeholder={placeholder}
        autoFocus={autoFocus}
      />
      {shortcut && <span class="search-field-shortcut">{shortcut}</span>}
    </label>
  );
}
