export function SwitchField({
  checked,
  onChange,
  children,
  label,
  description,
  disabled = false,
  class: className = "",
  ...props
}) {
  const body = children || label;
  return (
    <label class={`switch-field ${className}`}>
      <input
        {...props}
        class="switch-field-input"
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
      />
      <span class="switch-field-track" aria-hidden="true">
        <span class="switch-field-thumb" />
      </span>
      <span class="switch-field-copy">
        <span class="switch-field-label">{body}</span>
        {description && <span class="switch-field-description">{description}</span>}
      </span>
    </label>
  );
}
