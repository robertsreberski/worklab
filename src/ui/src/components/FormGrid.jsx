// §4.3 FormGrid — responsive N-column grid for FormFields. 1/2/3 columns.
export function FormGrid({ columns = 2, class: className = "", children }) {
  const n = Math.min(3, Math.max(1, columns));
  return <div class={`form-grid cols-${n} ${className}`.trim()}>{children}</div>;
}
