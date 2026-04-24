// §4.1 FormField — label + control + hint + error.
// Note: Switch-inside-FormField pass-through (§4.1 rule). Detected via
// `switchInside` prop or by checking the child's className at the call site.

import { Tooltip } from "./primitives/Tooltip.jsx";

export function FormField({
  label,
  required = false,
  hint,
  error,
  helpTooltip,
  htmlFor,
  switchInside = false,
  class: className = "",
  children,
}) {
  if (switchInside) {
    // Switch owns its own layout; we just render the control.
    return <div class={`form-field form-field-switch ${className}`.trim()}>{children}</div>;
  }
  return (
    <div class={`form-field ${className}`.trim()}>
      {label && (
        <label class="form-field-label" for={htmlFor}>
          <span>{label}</span>
          {required && <span class="form-field-required" aria-hidden="true">*</span>}
          {helpTooltip && (
            <Tooltip label={helpTooltip}>
              <span class="icon-button sm" aria-label="Help" style={{ width: "18px", height: "18px" }}>?</span>
            </Tooltip>
          )}
        </label>
      )}
      {children}
      {hint && <div class="form-field-hint">{hint}</div>}
      {error && <div class="form-field-error" role="alert">{error}</div>}
    </div>
  );
}
