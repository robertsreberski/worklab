// §4.7 Card — grouped rectangular surface. variant: default | spacious | inset.
// Optional `collapsible={{ summary, defaultOpen, count }}` renders as <details>
// with a styled summary row, replacing ad-hoc `<details class="card">` JSX.
import { Toolbar } from "./layout/index.js";

export function Card({
  variant = "default",
  kicker,
  title,
  headerRight,
  collapsible,
  class: className = "",
  children,
}) {
  const v =
    variant === "spacious" ? "card-spacious" :
    variant === "inset"    ? "card-inset" : "";

  if (collapsible) {
    const { summary, defaultOpen = false, count } = collapsible;
    return (
      <details class={`card card-collapsible ${v} ${className}`.trim()} open={defaultOpen}>
        <summary class="card-collapsible-summary">
          <span class="card-collapsible-label">{summary}</span>
          {typeof count === "number" && <span class="card-collapsible-count">{count}</span>}
        </summary>
        <div class="card-collapsible-body">{children}</div>
      </details>
    );
  }

  const hasHeader = kicker || title || headerRight;
  return (
    <section class={`card ${v} ${className}`.trim()}>
      {hasHeader && (
        <header class="card-header">
          <div class="card-header-copy">
            {kicker && <div class="card-kicker">{kicker}</div>}
            {title && <h3 class="card-title">{title}</h3>}
          </div>
          {headerRight && <Toolbar class="card-header-actions">{headerRight}</Toolbar>}
        </header>
      )}
      {children}
    </section>
  );
}
