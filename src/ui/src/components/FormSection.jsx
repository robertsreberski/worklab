// §4.2 FormSection — kicker + heading + description + children grid.
export function FormSection({
  kicker,
  title,
  description,
  class: className = "",
  children,
  ...props
}) {
  return (
    <section {...props} class={`form-section ${className}`.trim()}>
      {(kicker || title || description) && (
        <header class="form-section-header">
          {kicker && <span class="form-section-kicker">{kicker}</span>}
          {title && <h2 class="form-section-title">{title}</h2>}
          {description && <p class="form-section-description">{description}</p>}
        </header>
      )}
      {children}
    </section>
  );
}
