export function ShimmerBar({ height = 2, class: className = "" }) {
  return (
    <div
      class={`shimmer-bar ${className}`.trim()}
      style={{ height, borderRadius: height }}
      aria-hidden="true"
    />
  );
}
