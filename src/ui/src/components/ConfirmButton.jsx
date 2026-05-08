// §5.10 Confirmation — inline arm-then-commit button.
// Arms on first click, commits on second within `timeout` (default 2500ms).
// Uses wl-confirm-pulse while armed to draw attention.

import { useEffect, useState } from "preact/hooks";
import { Button } from "./primitives/Button.jsx";

export function ConfirmButton({
  onConfirm,
  children,
  confirmLabel = "Click again to confirm",
  timeout = 2500,
  class: className = "",
  variant = "destructive",
  ...props
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), timeout);
    return () => clearTimeout(t);
  }, [armed, timeout]);

  const classes = `${className} confirm-button${armed ? " confirm-button-armed" : ""}`.trim();

  async function handleClick(e) {
    if (!armed) {
      setArmed(true);
      return;
    }
    setArmed(false);
    await onConfirm?.(e);
  }

  return (
    <Button type="button" variant={variant} onClick={handleClick} class={classes} aria-pressed={armed} {...props}>
      {armed ? confirmLabel : children}
    </Button>
  );
}
