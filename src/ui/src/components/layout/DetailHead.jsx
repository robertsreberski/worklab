import { Icon } from "../Icon.jsx";
import { Kbd } from "../primitives/Kbd.jsx";

export function SectionMarker({ num, kicker, meta, id, class: className = "" }) {
  return (
    <div id={id} class={`section-marker ${className}`.trim()}>
      {num && <span class="section-marker-num">{num}</span>}
      {kicker && <span class="section-marker-label">{kicker}</span>}
      <span class="section-marker-rule" aria-hidden="true" />
      {meta && <span class="section-marker-meta">{meta}</span>}
    </div>
  );
}

export function DetailHead({
  crumbs = [],
  kicker,
  idPrefix,
  title,
  titlePlaceholder = "Untitled",
  titleClass = "",
  meta,
  actions,
  subBar,
  hint,
  glyph,
  icon,
  iconFrame = true,
  iconClass = "",
  onBack,
  backLabel = "Back",
  ariaLabel,
  class: className = "",
}) {
  const titleContent = title || <span class="placeholder">{titlePlaceholder}</span>;
  const titleIcon = icon || glyph;

  return (
    <header class={`detail-head pane-detail-head ds-detail-head ${className}`.trim()} aria-label={ariaLabel || (typeof title === "string" ? title : undefined)}>
      <div class="crumbs-row">
        {onBack && (
          <button type="button" class="back-btn" aria-label={backLabel} onClick={onBack}>
            <Icon name="chevron-left" size={14} />
          </button>
        )}
        {crumbs.map((crumb, index) => (
          <>
            {crumb.href ? <a key={`${crumb.label}-${index}`} class={`crumb ${index === crumbs.length - 1 ? "active" : ""}`.trim()} href={crumb.href}>{crumb.label}</a> : <span key={`${crumb.label}-${index}`} class={`crumb ${index === crumbs.length - 1 ? "active" : ""}`.trim()}>{crumb.label}</span>}
            {index < crumbs.length - 1 && <span class="crumb-sep" aria-hidden="true">/</span>}
          </>
        ))}
        {hint && (
          <span class="save-hint">
            {hint === true ? <><Kbd>⌘</Kbd><Kbd>S</Kbd> save</> : hint}
          </span>
        )}
      </div>
      <div class="title-row">
        <div class="title-block pane-detail-head-copy">
          {titleIcon && (
            iconFrame
              ? <div class={`title-icon pane-detail-icon ds-detail-icon ${iconClass}`.trim()} aria-hidden="true">{titleIcon}</div>
              : <div class={`title-icon title-icon-unframed ds-detail-identity ${iconClass}`.trim()} aria-hidden="true">{titleIcon}</div>
          )}
          <div class="title-copy pane-detail-head-titles">
            {kicker && <span class="kicker form-section-kicker">{kicker}</span>}
            <h2 class={titleClass}>
              {idPrefix && <span class="id-prefix">{idPrefix}</span>}
              {titleContent}
            </h2>
            {meta && <div class="title-meta pane-detail-subline">{meta}</div>}
          </div>
        </div>
        {actions && <div class="actions toolbar ds-toolbar ds-toolbar-end">{actions}</div>}
      </div>
      {subBar && <div class="sub-bar">{subBar}</div>}
    </header>
  );
}
