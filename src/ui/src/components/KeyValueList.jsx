// §4.19 KeyValueList — two-column grid. Keys all-caps muted, values mono text.
export function KeyValueList({ entries = [], class: className = "" }) {
  return (
    <dl class={`kv-list ${className}`.trim()}>
      {entries.map(([k, v], i) => (
        <>
          <dt key={`k-${i}`}>{k}</dt>
          <dd key={`v-${i}`}>{v ?? "—"}</dd>
        </>
      ))}
    </dl>
  );
}
