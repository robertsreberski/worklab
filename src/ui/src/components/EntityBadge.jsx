import { BadgeToken } from "./primitives/BadgeToken.jsx";
import { entityBadgeLabel, entityBadgeMeta, normalizeEntityBadgeKind } from "../lib/entityBadges.js";

export function EntityBadge({
  kind,
  label,
  token,
  id,
  href,
  missing = false,
  size = "sm",
  class: className = "",
  title,
  ...rest
}) {
  const normalized = normalizeEntityBadgeKind(kind);
  const meta = entityBadgeMeta(normalized);
  const display = entityBadgeLabel({ label, token, type: normalized, id });
  const cls = `entity-badge entity-badge--${normalized} ${missing ? "entity-badge--missing" : ""} ${className}`.trim();
  return (
    <BadgeToken
      glyph={meta.glyph}
      href={missing ? null : href}
      size={size}
      class={cls}
      title={title || token || display}
      data-kind={normalized}
      {...rest}
    >
      {display}
    </BadgeToken>
  );
}

export function EntityBadgeText({ references = [] }) {
  return (
    <>
      {(references || []).map((reference, index) => (
        typeof reference === "string"
          ? reference
          : <EntityBadge key={`${reference.kind || reference.type}-${reference.id || reference.name}-${index}`} {...reference} />
      ))}
    </>
  );
}
