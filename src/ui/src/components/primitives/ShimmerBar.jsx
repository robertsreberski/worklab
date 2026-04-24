// §3.15 ShimmerBar — subtle streaming cue, 2px horizontal line with accent
// gradient sweeping via wl-shimmer. Only mounts while a run is streaming.
export function ShimmerBar({ height = 2, class: className = "" }) {
  return (
    <div
      class={`shimmer-bar ${className}`.trim()}
      style={{ height: `${height}px`, borderRadius: `${height}px` }}
      aria-hidden="true"
    />
  );
}
