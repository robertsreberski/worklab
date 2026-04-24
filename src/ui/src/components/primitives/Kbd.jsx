// §3.20 Kbd — render a keyboard shortcut inline.
export function Kbd({ children, class: className = "" }) {
  return <kbd class={`kbd ${className}`.trim()}>{children}</kbd>;
}
