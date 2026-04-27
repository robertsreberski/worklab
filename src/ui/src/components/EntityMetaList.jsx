// Compact definition list for entity detail rails.
export function EntityMetaList({ items = [], class: className = "" }) {
  const visibleItems = items.filter((item) => item && item.value !== undefined && item.value !== null && item.value !== "");
  if (!visibleItems.length) return null;

  return (
    <dl class={`entity-meta-list ${className}`.trim()}>
      {visibleItems.map((item) => (
        <div class="entity-meta-row" key={item.label}>
          <dt>{item.label}</dt>
          <dd class={item.mono === false ? "" : "mono"}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
