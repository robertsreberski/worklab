// §3.5 SearchField — filter within a list scope.
// role=search, / shortcut to focus via global handler, Esc clears+blurs.
import { useEffect, useId, useRef } from "preact/hooks";
import { Icon } from "../Icon.jsx";

export function SearchField({
  value,
  onInput,
  onClear,
  placeholder = "Search",
  shortcut,
  class: className = "",
  inputClass = "",
  autoFocus = false,
  ariaLabel,
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

  function handleKey(e) {
    if (e.key === "Escape" && (value || "").length) {
      e.preventDefault();
      onInput?.({ target: { value: "" } });
      onClear?.();
      inputRef.current?.blur?.();
    }
  }

  return (
    <label
      class={`search-field ${className}`.trim()}
      for={inputId}
      role="search"
      aria-label={ariaLabel}
    >
      <Icon name="search" size={14} class="search-field-icon" />
      <input
        id={inputId}
        ref={inputRef}
        class={`search-field-input ${inputClass}`.trim()}
        type="search"
        value={value ?? ""}
        onInput={onInput}
        onKeyDown={handleKey}
        placeholder={placeholder}
        autoFocus={autoFocus}
        aria-label={ariaLabel || placeholder}
      />
      {value && (
        <button
          type="button"
          class="search-field-clear"
          aria-label="Clear search"
          onClick={() => {
            onInput?.({ target: { value: "" } });
            onClear?.();
            inputRef.current?.focus?.();
          }}
        >×</button>
      )}
      {shortcut && <span class="search-field-shortcut">{shortcut}</span>}
    </label>
  );
}
