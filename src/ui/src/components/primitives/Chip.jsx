// §3.10 Chip — inline metadata badge.
// variant: tag | category | trigger | filter
// Not a chip: StatusPill, PriorityChip, ToolToken.

export function Chip({
  variant = "tag",
  children,
  onRemove,
  leading,
  "aria-label": ariaLabel,
  selected = false,
  onClick,
  class: className = "",
  ...rest
}) {
  const isFilter = variant === "filter";
  const cls = `chip chip-${variant} ${isFilter && selected ? "selected" : ""} ${className}`.trim();
  const commonProps = {
    class: cls,
    "aria-label": ariaLabel,
    ...rest,
  };
  const body = (
    <>
      {leading}
      <span>{children}</span>
      {onRemove && (
        <button
          type="button"
          class="chip-remove"
          onClick={(e) => { e.stopPropagation(); onRemove(e); }}
          aria-label="Remove"
        >×</button>
      )}
    </>
  );
  if (isFilter) {
    return (
      <button
        type="button"
        aria-pressed={selected}
        onClick={onClick}
        {...commonProps}
      >
        {body}
      </button>
    );
  }
  return <span {...commonProps}>{body}</span>;
}
