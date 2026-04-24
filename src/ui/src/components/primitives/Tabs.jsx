// §3.24 Tabs / TabGroup — sibling view switcher.
// Pass `tab.panelId` to wire `aria-controls` for assistive tech; if the caller
// renders a matching <div role="tabpanel" id={panelId}> they get full a11y.

import { Badge } from "./Badge.jsx";

export function Tabs({
  value,
  onChange,
  tabs = [],
  ariaLabel,
  class: className = "",
}) {
  function onKeyDown(e) {
    const enabled = tabs.filter((t) => !t.disabled);
    if (!enabled.length) return;
    const current = enabled.findIndex((t) => t.value === value);
    let next = current;
    if (e.key === "ArrowRight") { e.preventDefault(); next = (current + 1) % enabled.length; }
    else if (e.key === "ArrowLeft") { e.preventDefault(); next = (current - 1 + enabled.length) % enabled.length; }
    else return;
    onChange?.(enabled[Math.max(0, next)].value);
  }
  return (
    <div
      class={`tabs ${className}`.trim()}
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
    >
      {tabs.map((t) => {
        const selected = t.value === value;
        return (
          <button
            key={t.value}
            type="button"
            class="tab"
            role="tab"
            aria-selected={selected}
            aria-controls={t.panelId}
            tabIndex={selected ? 0 : -1}
            disabled={t.disabled}
            onClick={() => !t.disabled && onChange?.(t.value)}
          >
            <span>{t.label}</span>
            {t.count != null && <Badge>{t.count}</Badge>}
          </button>
        );
      })}
    </div>
  );
}
