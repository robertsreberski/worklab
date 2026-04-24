// §4.6 PaneRow — 36px row in a Pane list.

export function PaneRow({
  href,
  active = false,
  disabled = false,
  leading,
  title,
  sub,
  trailing,
  onClick,
  class: className = "",
}) {
  const cls = `pane-row ${active ? "active" : ""} ${disabled ? "disabled" : ""} ${className}`.trim();
  const body = (
    <>
      {leading && <div>{leading}</div>}
      <div class="pane-row-main">
        {title && <div class="pane-row-title">{title}</div>}
        {sub && <div class="pane-row-sub">{sub}</div>}
      </div>
      {trailing && <div class="pane-row-meta">{trailing}</div>}
    </>
  );
  if (href && !disabled) {
    return (
      <a href={href} class={cls} onClick={onClick}>
        {body}
      </a>
    );
  }
  return (
    <div class={cls} role="button" tabIndex={disabled ? -1 : 0} onClick={onClick}>
      {body}
    </div>
  );
}
