export function PriorityChip({ priority }) {
  const p = Number(priority);
  if (!p || p < 1) return null;
  const tone = p === 1 ? "red" : p === 2 ? "yellow" : "muted";
  return (
    <span class="priority-chip" data-tone={tone}>
      P{p}
    </span>
  );
}
