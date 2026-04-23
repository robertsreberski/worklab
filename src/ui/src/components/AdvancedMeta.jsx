import { Icon } from "./Icon.jsx";

export function AdvancedMeta({ title = "Advanced details", items = [], children }) {
  const visibleItems = items.filter((item) => item && item.value != null && item.value !== "");
  if (!visibleItems.length && !children) return null;
  return (
    <details class="advanced-meta">
      <summary>
        <span>{title}</span>
        <Icon name="chevron-down" size={14} class="advanced-meta-chevron" />
      </summary>
      <div class="advanced-meta-body">
        {visibleItems.length > 0 && (
          <dl class="advanced-meta-list">
            {visibleItems.map((item) => (
              <div key={item.label}>
                <dt>{item.label}</dt>
                <dd>{item.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {children}
      </div>
    </details>
  );
}
