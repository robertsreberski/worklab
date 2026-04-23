export function EntityHeader({ eyebrow, title, description, meta, actions, class: className = "" }) {
  return (
    <section class={`entity-header ${className}`}>
      <div class="entity-header-copy">
        {eyebrow && <div class="eyebrow">{eyebrow}</div>}
        <h2>{title}</h2>
        {description && <p>{description}</p>}
        {meta && <div class="entity-header-meta">{meta}</div>}
      </div>
      {actions && <div class="entity-header-actions">{actions}</div>}
    </section>
  );
}
