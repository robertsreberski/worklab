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
  buttonRef,
  children,
  class: className = "",
  ...rest
}) {
  const cls = `button ${variant} ${size} ${className}`.trim();
  return (
    <button
      ref={buttonRef}
      type={type}
      class={cls}
      disabled={disabled || loading}
      aria-disabled={disabled || loading ? "true" : undefined}
      aria-busy={loading ? "true" : undefined}
      onClick={onClick}
      {...rest}
    >
      {loading ? (
        <>
          <span class="spinner" aria-hidden="true" />
          {children != null && children !== false ? <span class="sr-only">{children}</span> : null}
        </>
      ) : (
        <>
          {iconLeft}
          {children != null && children !== false ? (
            <span class="button-label">{children}</span>
          ) : null}
          {iconRight}
        </>
      )}
    </button>
  );
}
