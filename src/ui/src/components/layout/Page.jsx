export function Toolbar({ children, align = "end", class: className = "" }) {
  return (
    <div class={`toolbar ds-toolbar ds-toolbar-${align} ${className}`.trim()}>
      {children}
    </div>
  );
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

export function SummaryGrid({ children, class: className = "" }) {
  return <div class={`summary-tiles ds-summary-grid ${className}`.trim()}>{children}</div>;
}

export function PanelGrid({ children, class: className = "" }) {
  return <div class={`ds-panel-grid ${className}`.trim()}>{children}</div>;
}
