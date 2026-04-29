import { Icon } from "../Icon.jsx";
import { IconButton } from "./IconButton.jsx";

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  let next = number;
  if (min != null) next = Math.max(Number(min), next);
  if (max != null) next = Math.min(Number(max), next);
  return next;
}

export function NumberStepper({
  value,
  onChange,
  min,
  max,
  step = 1,
  disabled = false,
  ariaLabel,
  class: className = "",
}) {
  function commit(nextValue) {
    if (nextValue === "") {
      onChange?.("");
      return;
    }
    const next = clamp(nextValue, min, max);
    if (next !== "") onChange?.(next);
  }
  function nudge(direction) {
    const base = value === "" || value == null ? 0 : Number(value);
    commit((Number.isFinite(base) ? base : 0) + direction * Number(step || 1));
  }
  return (
    <div class={`number-stepper ${className}`.trim()}>
      <input
        type="text"
        inputMode="decimal"
        class="input number-stepper-input"
        value={value ?? ""}
        disabled={disabled}
        aria-label={ariaLabel}
        onInput={(event) => onChange?.(event.currentTarget.value)}
        onBlur={(event) => commit(event.currentTarget.value)}
      />
      <div class="number-stepper-buttons">
        <IconButton
          size="sm"
          disabled={disabled}
          aria-label={`Increase ${ariaLabel || "value"}`}
          icon={<Icon name="chevron-up" size={12} />}
          onClick={() => nudge(1)}
        />
        <IconButton
          size="sm"
          disabled={disabled}
          aria-label={`Decrease ${ariaLabel || "value"}`}
          icon={<Icon name="chevron-down" size={12} />}
          onClick={() => nudge(-1)}
        />
      </div>
    </div>
  );
}

export function DurationInput({
  value,
  onChange,
  unit = "minutes",
  min = 0,
  step,
  disabled = false,
  ariaLabel,
  class: className = "",
}) {
  const factor = unit === "seconds" ? 1000 : 60000;
  const precision = unit === "seconds" ? 2 : 4;
  const display = value === "" || value == null
    ? ""
    : Number((Number(value) / factor).toFixed(precision)).toString();
  function commit(nextValue) {
    if (nextValue === "") {
      onChange?.("");
      return;
    }
    const next = Number(nextValue);
    if (Number.isFinite(next)) onChange?.(Math.round(next * factor));
  }
  return (
    <div class={`duration-input ${className}`.trim()}>
      <NumberStepper
        value={display}
        min={min}
        step={step ?? (unit === "seconds" ? 1 : 0.25)}
        disabled={disabled}
        ariaLabel={ariaLabel || `Duration in ${unit}`}
        onChange={commit}
      />
      <span class="duration-input-unit">{unit}</span>
    </div>
  );
}
