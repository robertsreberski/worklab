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
              <>
                <dt key={`label-${item.label}`}>{item.label}</dt>
                <dd key={`value-${item.label}`}>{item.value}</dd>
              </>
            ))}
          </dl>
        )}
        {children}
      </div>
    </details>
  );
}
