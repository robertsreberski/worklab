export function LivePulse({ color = "var(--yellow)", size = 7, class: className = "" }) {
  return (
    <span
      class={`live-pulse ${className}`.trim()}
      style={{ "--pulse-color": color, "--pulse-size": `${size}px` }}
      aria-hidden="true"
    >
      <span class="live-pulse-ring" />
      <span class="live-pulse-core" />
    </span>
  );
}
