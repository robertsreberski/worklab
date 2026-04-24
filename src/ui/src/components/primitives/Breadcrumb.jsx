// §3.23 Breadcrumb — path from top-level nav to current surface.
// items: [{ label, href? }, …] — the last item is treated as current and non-clickable.
// Truncates middle levels with ellipsis if path is deeper than 3.

export function Breadcrumb({ items = [], class: className = "" }) {
  if (!items.length) return null;
  let display = items;
  if (items.length > 3) {
    display = [items[0], { label: "…" }, items[items.length - 1]];
  }
  return (
    <nav class={`breadcrumb ${className}`.trim()} aria-label="Breadcrumb">
      {display.map((item, i) => {
        const isLast = i === display.length - 1;
        const sep = i < display.length - 1 ? <span class="breadcrumb-sep" aria-hidden="true">›</span> : null;
        if (isLast) {
          return (
            <span key={i} class="breadcrumb-current" aria-current="page">
              {item.label}
              {sep}
            </span>
          );
        }
        if (item.label === "…") {
          return (
            <span key={i} class="breadcrumb-item">
              <span class="breadcrumb-current">…</span>
              {sep}
            </span>
          );
        }
        return (
          <span key={i} class="breadcrumb-item">
            {item.href ? <a href={item.href}>{item.label}</a> : <span>{item.label}</span>}
            {sep}
          </span>
        );
      })}
    </nav>
  );
}
