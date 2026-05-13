export function buildDelegationContextBlock({ parentTask, parentRunId, parentResult } = {}) {
  if (!parentTask) return "";
  const lines = ["## Parent task context"];
  const parentRef = parentTask.task_key || parentTask.id;
  lines.push(`Delegated by parent task **${parentRef}** ("${parentTask.title || ""}").`);
  if (parentRunId) lines.push(`Parent run id: \`${parentRunId}\``);
  const summary = parentResult?.summary && String(parentResult.summary).trim();
  const finalText = parentResult?.final_text && String(parentResult.final_text).trim();
  const details = parentResult?.details && String(parentResult.details).trim();
  if (summary) lines.push(`Parent summary: ${summary}`);
  if (finalText) {
    lines.push("", "**Parent final_text (read this; don't redo work it already covers):**", finalText);
  } else if (details) {
    lines.push("", "**Parent details:**", details.slice(0, 2000));
  }
  lines.push(
    "",
    "Use this context to skip rediscovery of work the parent already did. Build on it; don't restart from zero. If the parent's findings conflict with what you observe, surface the conflict in your final result rather than silently overriding.",
  );
  return lines.join("\n");
}
