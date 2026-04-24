// §3.13 PriorityChip — priority 0 renders nothing (absence communicates default).
// 1 = grey, 2 = amber, 3 = red-amber.
export function PriorityChip({ priority }) {
  const p = Number(priority);
  if (!p || p < 1) return null;
  const tone = p === 3 ? "red" : p === 2 ? "yellow" : "grey";
  return (
    <span class="priority-chip" data-tone={tone}>
      P{p}
    </span>
  );
}
