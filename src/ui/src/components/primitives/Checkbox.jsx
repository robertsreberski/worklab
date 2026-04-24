// §3.8 Checkbox — multi-select or compound on/off.
import { useEffect, useRef } from "preact/hooks";
import { Icon } from "../Icon.jsx";

let cbUid = 0;

export function Checkbox({
  checked = false,
  indeterminate = false,
  onChange,
  label,
  description,
  disabled = false,
  id,
  class: className = "",
  children,
}) {
  const inputId = id || `wl-check-${++cbUid}`;
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate;
  }, [indeterminate]);
  return (
    <label
      class={`checkbox ${className}`.trim()}
      for={inputId}
      aria-disabled={disabled ? "true" : undefined}
    >
      <input
        ref={ref}
        id={inputId}
        type="checkbox"
        class="checkbox-input"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange?.(e.currentTarget.checked, e)}
      />
      <span class={`checkbox-box ${indeterminate ? "checkbox-box-indeterminate" : ""}`}>
        {(checked || indeterminate) && <Icon name="check" size={12} strokeWidth={2.5} />}
      </span>
      <span class="checkbox-copy">
        {label && <span class="checkbox-label">{label}</span>}
        {description && <span class="checkbox-description">{description}</span>}
        {children}
      </span>
    </label>
  );
}
