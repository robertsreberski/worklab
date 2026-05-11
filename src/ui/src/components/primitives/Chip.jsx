// §3.10 Chip — inline metadata badge.
// Canonical variants (critique §09 — rule of one, no inventing):
//   muted  · tag       — categorical identity (project, type)
//   accent · link      — relationship to another entity; click implies navigate
//   warn   · pending   — soft amber; non-blocking attention
//   error  · alert     — coral; only one per row
//   inline · meta      — borderless, transparent, --text-subtle
// Existing aliases kept for backwards-compat: tag/category/trigger/filter/ghost.
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
