// §3.3 Input — single-line text / number / password entry.
export function Input({
  type = "text",
  value,
  onInput,
  onChange,
  placeholder,
  disabled,
  readOnly,
  invalid,
  size = "md",
  class: className = "",
  ...rest
}) {
  const cls = `input ${size} ${invalid ? "invalid" : ""} ${className}`.trim();
  return (
    <input
      type={type}
      class={cls}
      value={value ?? ""}
      placeholder={placeholder}
      disabled={disabled}
      readOnly={readOnly}
      aria-invalid={invalid ? "true" : undefined}
      onInput={onInput}
      onChange={onChange}
      {...rest}
    />
  );
}
