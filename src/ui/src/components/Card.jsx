// §4.7 Card — grouped rectangular surface. variant: default | spacious | inset.
export function Card({
  variant = "default",
  kicker,
  title,
  headerRight,
  class: className = "",
  children,
}) {
  const v =
    variant === "spacious" ? "card-spacious" :
    variant === "inset"    ? "card-inset" : "";
  return (
    <section class={`card ${v} ${className}`.trim()}>
      {(kicker || title || headerRight) && (
        <header class="card-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "var(--sp-3)" }}>
          <div>
            {kicker && <div class="card-kicker">{kicker}</div>}
            {title && <h3 class="card-title">{title}</h3>}
          </div>
          {headerRight}
        </header>
      )}
      {children}
    </section>
  );
}
