export function Toolbar({ children, align = "end", class: className = "" }) {
  return (
    <div class={`toolbar ds-toolbar ds-toolbar-${align} ${className}`.trim()}>
      {children}
    </div>
  );
}

export function InlineHead({ children, class: className = "", as: Component = "div", ...props }) {
  return <Component {...props} class={`ds-inline-head ${className}`.trim()}>{children}</Component>;
}

export function PageHeader({
  kicker,
  title,
  description,
  actions,
  class: className = "",
}) {
  return (
    <header class={`ds-page-head ${className}`.trim()}>
      <div class="ds-page-title">
        {kicker && <span class="form-section-kicker">{kicker}</span>}
        {title && <h1>{title}</h1>}
        {description && <p>{description}</p>}
      </div>
      {actions && <Toolbar class="page-actions">{actions}</Toolbar>}
    </header>
  );
}

export function Page({
  kicker,
  title,
  description,
  actions,
  class: className = "",
  children,
}) {
  return (
    <div class={`page-wrap ds-page ${className}`.trim()}>
      {(kicker || title || description || actions) && (
        <PageHeader
          kicker={kicker}
          title={title}
          description={description}
          actions={actions}
        />
      )}
      {children}
    </div>
  );
}

export function SummaryGrid({ children, class: className = "", as: Component = "div", ...props }) {
  return <Component {...props} class={`summary-tiles ds-summary-grid ${className}`.trim()}>{children}</Component>;
}

export function PanelGrid({ children, class: className = "", ...props }) {
  return <div {...props} class={`ds-panel-grid ${className}`.trim()}>{children}</div>;
}

export function ControlGroupStack({ children, class: className = "", ...props }) {
  return <div {...props} class={`ds-control-groups ${className}`.trim()}>{children}</div>;
}

export function ControlGroup({ title, description, children, class: className = "", gridClass = "", ...props }) {
  return (
    <section {...props} class={`ds-control-group ${className}`.trim()}>
      <header class="ds-control-group-head">
        <h4>{title}</h4>
        {description && <p>{description}</p>}
      </header>
      <div class={`ds-control-grid ${gridClass}`.trim()}>{children}</div>
    </section>
  );
}

export function SectionGroup({
  label,
  count,
  children,
  class: className = "",
  as: Component = "section",
  ...props
}) {
  return (
    <Component {...props} class={`ds-section-group ${className}`.trim()}>
      <header class="ds-section-group-head">
        <span class="ds-section-group-label">{label}</span>
        {count !== undefined && count !== null && <span class="ds-section-group-count">{count}</span>}
      </header>
      {children}
    </Component>
  );
}

export function SectionStack({
  children,
  class: className = "",
  as: Component = "div",
  ...props
}) {
  return <Component {...props} class={`ds-section-stack ${className}`.trim()}>{children}</Component>;
}
