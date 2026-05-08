import { Toolbar } from "./Page.jsx";

export function DetailHeader({
  icon,
  kicker,
  title,
  meta,
  actions,
  iconFrame = true,
  iconClass = "",
  class: className = "",
}) {
  return (
    <header class={`pane-detail-head ds-detail-head ${className}`.trim()}>
      <div class="pane-detail-head-copy">
        {icon && (
          iconFrame
            ? <div class={`pane-detail-icon ds-detail-icon ${iconClass}`.trim()} aria-hidden="true">{icon}</div>
            : <div class="ds-detail-identity" aria-hidden="true">{icon}</div>
        )}
        <div class="pane-detail-head-titles">
          {kicker && <span class="form-section-kicker">{kicker}</span>}
          {title && <h2>{title}</h2>}
          {meta && <div class="pane-detail-subline">{meta}</div>}
        </div>
      </div>
      {actions && <Toolbar>{actions}</Toolbar>}
    </header>
  );
}

export function EntityEditorLayout({ main, rail, class: className = "" }) {
  return (
    <div class={`entity-editor-layout ds-entity-editor-layout ${className}`.trim()}>
      <main class="entity-editor-main">{main}</main>
      {rail && <aside class="entity-editor-rail">{rail}</aside>}
    </div>
  );
}

export function RailStack({ children, class: className = "" }) {
  return <div class={`ds-rail-stack ${className}`.trim()}>{children}</div>;
}
