// §3.1 Button — sole affordance for direct user-initiated action.
// variant: primary | secondary | ghost | destructive
// size: sm (28) | md (32, default) | lg (40)

export function Button({
  variant = "secondary",
  size = "md",
  disabled = false,
  loading = false,
  iconLeft,
  iconRight,
  type = "button",
  onClick,
  children,
  class: className = "",
  ...rest
}) {
  const cls = `button ${variant} ${size} ${className}`.trim();
  return (
    <button
      type={type}
      class={cls}
      disabled={disabled || loading}
      aria-disabled={disabled || loading ? "true" : undefined}
      onClick={onClick}
      {...rest}
    >
      {loading ? (
        <span class="spinner" aria-hidden="true" />
      ) : (
        <>
          {iconLeft}
          {children}
          {iconRight}
        </>
      )}
    </button>
  );
}
