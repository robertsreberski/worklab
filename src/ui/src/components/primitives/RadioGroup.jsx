// §3.9 RadioGroup — segmented bar for 2–5 mutually exclusive options.
import { useRef } from "preact/hooks";

export function RadioGroup({
  value,
  onChange,
  options = [],
  ariaLabel,
  variant = "segmented",
  class: className = "",
}) {
  const containerRef = useRef(null);

  function onKeyDown(e) {
    const enabled = options.map((o, i) => ({ o, i })).filter(({ o }) => !o.disabled);
    if (!enabled.length) return;
    const current = enabled.findIndex(({ o }) => o.value === value);
    let next = current;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      next = (current + 1 + enabled.length) % enabled.length;
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      next = (current - 1 + enabled.length) % enabled.length;
    } else return;
    const opt = enabled[Math.max(0, next)].o;
    onChange?.(opt.value);
  }

  return (
    <div
      ref={containerRef}
      class={`radio-group radio-group-${variant} ${className}`.trim()}
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
    >
      {options.map((opt, index) => {
        const checked = opt.value === value;
        const firstEnabled = !value && index === options.findIndex((item) => !item.disabled);
        return (
          <button
            key={opt.value}
            type="button"
            class="radio-group-option"
            role="radio"
            aria-checked={checked}
            disabled={opt.disabled}
            tabIndex={checked || firstEnabled ? 0 : -1}
            onClick={() => !opt.disabled && onChange?.(opt.value)}
          >
            {opt.icon}
            <span class="radio-group-option-copy">
              <span>{opt.label}</span>
              {opt.description && <small>{opt.description}</small>}
            </span>
          </button>
        );
      })}
    </div>
  );
}
