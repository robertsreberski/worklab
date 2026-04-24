// §4.13 LoadingState — 120px ShimmerBar + caption.
export function LoadingState({ caption = "Loading…", class: className = "" }) {
  return (
    <div class={`loading-state ${className}`.trim()} role="status" aria-live="polite">
      <div class="loading-state-bar" />
      <div class="loading-state-caption">{caption}</div>
    </div>
  );
}
