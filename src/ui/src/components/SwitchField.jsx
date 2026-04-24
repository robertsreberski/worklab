// SwitchField — compat wrapper over the new Switch primitive (§3.7).
// The new primitive fixes the alignment bug (track anchored to label x-height).
// New code should import `Switch` from `primitives/Switch.jsx` directly.
import { Switch } from "./primitives/Switch.jsx";

export function SwitchField({
  checked,
  onChange,
  children,
  label,
  description,
  disabled = false,
  class: className = "",
}) {
  return (
    <Switch
      checked={!!checked}
      onChange={(nextChecked, event) => {
        // Preserve prior API: onChange receives the raw event.
        onChange?.(event ?? { target: { checked: nextChecked } });
      }}
      label={label || children}
      description={description}
      disabled={disabled}
      class={className}
    >
      {!label && children ? (
        <>
          <span class="switch-label">{children}</span>
          {description && <span class="switch-description">{description}</span>}
        </>
      ) : null}
    </Switch>
  );
}
