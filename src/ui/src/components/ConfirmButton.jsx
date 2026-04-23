import { useEffect, useState } from "preact/hooks";

export function ConfirmButton({
  onConfirm,
  children,
  confirmLabel = "Click again to confirm",
  timeout = 4000,
  class: className = "",
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
    try {
      await onConfirm?.(e);
    } catch (err) {
      // Swallow — parent is responsible for surfacing errors
      // (e.g. via useFormSave / toast). Resetting armed state was the only
      // guarantee this component owned.
      throw err;
    }
  }
  return (
    <button type="button" onClick={handleClick} class={classes} aria-pressed={armed} {...props}>
      {armed ? confirmLabel : children}
    </button>
  );
}
