export function BadgeToken({
  children,
  glyph,
  leading,
  href,
  size = "sm",
  tone,
  class: className = "",
  title,
  "data-kind": dataKind,
  ...rest
}) {
  const cls = `badge-token badge-token-${size} ${className}`.trim();
  const style = tone ? { "--badge-token-tone": tone } : undefined;
  const body = (
    <>
      {leading && <span class="badge-token-leading" aria-hidden="true">{leading}</span>}
      {glyph && <span class="badge-token-glyph" aria-hidden="true">{glyph}</span>}
      <span class="badge-token-label">{children}</span>
    </>
  );
  if (href) {
    return (
      <a class={cls} href={href} style={style} title={title} data-kind={dataKind} {...rest}>
        {body}
      </a>
    );
  }
  return (
    <span class={cls} style={style} title={title} data-kind={dataKind} {...rest}>
      {body}
    </span>
  );
}
