import { Icon } from "./Icon.jsx";

export function CheckboxField({
  checked,
  onChange,
  children,
  label,
  type = "checkbox",
  disabled = false,
  class: className = "",
  ...props
}) {
  const body = children || label;
  return (
    <label class={`choice-label custom-check ${className}`}>
      <input
        {...props}
        class="custom-check-input"
        type={type}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
      />
      <span class={`custom-check-box custom-check-box-${type}`} aria-hidden="true">
        {checked && <Icon name="check" size={12} strokeWidth={2.4} />}
      </span>
      <span>{body}</span>
    </label>
  );
}
