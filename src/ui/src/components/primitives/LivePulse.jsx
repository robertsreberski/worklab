// §3.14 LivePulse — "alive" marker, visually richer than StatusDot pulse.
// Default color per spec is --status-progress.
export function LivePulse({ color = "var(--status-progress)", size = 10, class: className = "" }) {
  return (
    <span
      class={`live-pulse ${className}`.trim()}
      style={{ "--pulse-color": color, "--dot-size": `${size}px` }}
      aria-hidden="true"
    >
      <span class="live-pulse-ring" />
      <span class="live-pulse-core" />
    </span>
  );
}
