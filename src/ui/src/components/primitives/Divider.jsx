// §3.21 Divider — 1px rule between distinct semantic groups.
export function Divider({ class: className = "" }) {
  return <hr class={`divider ${className}`.trim()} />;
}
