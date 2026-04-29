import { Icon } from "../Icon.jsx";

export const TASK_STAGE_META = {
  plan: { label: "Plan", tone: "var(--accent)", icon: "circle-dot" },
  execute: { label: "Execute", tone: "var(--status-todo)", icon: "circle" },
  running: { label: "Running", tone: "var(--status-progress)", icon: "zap" },
  review: { label: "Review", tone: "var(--status-review)", icon: "diamond" },
  awaiting_user: { label: "Needs input", tone: "var(--status-error)", icon: "alert-triangle" },
  awaiting_children: { label: "Waiting", tone: "var(--status-progress)", icon: "clock" },
  blocked: { label: "Blocked", tone: "var(--status-error)", icon: "square" },
  done: { label: "Done", tone: "var(--status-done)", icon: "check-circle" },
};

export function taskStageMeta(stage) {
  return TASK_STAGE_META[stage] || { label: stage || "Stage", tone: "var(--status-muted)", icon: "circle" };
}

export function StageToken({
  stage = "execute",
  variant = "pill",
  active = false,
  disabled = false,
  label,
  onClick,
  as,
  class: className = "",
  ...rest
}) {
  const meta = taskStageMeta(stage);
  const content = (
    <>
      <span class="stage-token-glyph" aria-hidden="true" />
      <span class="stage-token-label status-pill-label">{label || meta.label}</span>
      {variant === "menu" && <Icon name="chevron-down" size={12} class="stage-token-chevron" aria-hidden="true" />}
    </>
  );
  const compatClass = variant === "grid" ? "status-grid-btn" : "status-pill";
  const cls = `stage-token stage-token-${variant} ${compatClass} ${active ? "active" : ""} ${className}`.trim();
  const style = { "--stage-tone": meta.tone };
  const isButton = as ? as === "button" : (variant === "grid" || variant === "menu" || onClick);

  if (isButton) {
    return (
      <button
        type="button"
        class={cls}
        data-stage={stage}
        style={style}
        aria-pressed={variant === "grid" ? active : undefined}
        disabled={disabled}
        onClick={onClick}
        {...rest}
      >
        {content}
      </button>
    );
  }

  return (
    <span class={cls} data-stage={stage} style={style} title={label || meta.label} {...rest}>
      {content}
    </span>
  );
}
