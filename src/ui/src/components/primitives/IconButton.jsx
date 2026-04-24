// §3.2 IconButton — compact icon-only action. aria-label required.

export function IconButton({
  icon,
  "aria-label": ariaLabel,
  variant = "ghost",
  size = "md",
  disabled = false,
  onClick,
  type = "button",
  class: className = "",
  ...rest
}) {
  const cls = `icon-button ${variant} ${size} ${className}`.trim();
  return (
    <button
      type={type}
      class={cls}
      disabled={disabled}
      aria-disabled={disabled ? "true" : undefined}
      aria-label={ariaLabel}
      onClick={onClick}
      {...rest}
    >
      {icon}
    </button>
  );
}
