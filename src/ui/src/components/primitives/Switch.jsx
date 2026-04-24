// §3.7 Switch — binary on/off with aligned label + description.
// Track sits at `align-self: start` so it anchors to the label x-height
// regardless of whether the description wraps to multiple lines.
// This replaces SwitchField.jsx (now a compat wrapper).

let switchUid = 0;

export function Switch({
  checked = false,
  onChange,
  label,
  description,
  disabled = false,
  id,
  class: className = "",
  children,
}) {
  const inputId = id || `wl-switch-${++switchUid}`;
  const copy = children ?? (
    <>
      {label && <span class="switch-label">{label}</span>}
      {description && <span class="switch-description">{description}</span>}
    </>
  );
  return (
    <label
      class={`switch ${className}`.trim()}
      for={inputId}
      aria-disabled={disabled ? "true" : undefined}
    >
      <input
        id={inputId}
        type="checkbox"
        class="switch-input"
        role="switch"
        aria-checked={checked}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange?.(e.currentTarget.checked, e)}
      />
      <span class="switch-track" aria-hidden="true">
        <span class="switch-thumb" />
      </span>
      <span class="switch-copy">{copy}</span>
    </label>
  );
}
