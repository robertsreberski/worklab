// §3.5 SearchField — filter within a list scope.
// role=search, / shortcut to focus via global handler, Esc clears+blurs.
import { useId, useRef } from "preact/hooks";
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
  inputRef: forwardedRef,
}) {
  const inputRef = useRef(null);
  const inputId = useId();

  function setRef(node) {
    inputRef.current = node;
    if (!forwardedRef) return;
    if (typeof forwardedRef === "function") forwardedRef(node);
    else forwardedRef.current = node;
  }

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
        ref={setRef}
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
