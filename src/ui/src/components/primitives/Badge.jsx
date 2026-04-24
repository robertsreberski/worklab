// §3.18 Badge — numeric count attached to nav items or section headers.
export function Badge({ children, variant = "default", class: className = "" }) {
  const cls = `badge ${variant !== "default" ? variant : ""} ${className}`.trim();
  return <span class={cls}>{children}</span>;
}
