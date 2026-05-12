// §3.18 Badge — numeric count attached to nav items or section headers.
import { BadgeToken } from "./BadgeToken.jsx";

export function Badge({ children, variant = "default", class: className = "" }) {
  const cls = `badge ${variant !== "default" ? variant : ""} ${className}`.trim();
  return <BadgeToken size="xs" class={cls}>{children}</BadgeToken>;
}
