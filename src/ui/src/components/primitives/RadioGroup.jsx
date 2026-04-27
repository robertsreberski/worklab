// §3.9 RadioGroup — segmented bar for 2–5 mutually exclusive options.
import { useRef } from "preact/hooks";

export function RadioGroup({
  value,
  onChange,
  options = [],
  ariaLabel,
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
      class={`radio-group ${className}`.trim()}
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
    >
      {options.map((opt) => {
        const checked = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            class="radio-group-option"
            role="radio"
            aria-checked={checked}
            disabled={opt.disabled}
            tabIndex={checked ? 0 : -1}
            onClick={() => !opt.disabled && onChange?.(opt.value)}
          >
            {opt.icon}
            <span>{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}
