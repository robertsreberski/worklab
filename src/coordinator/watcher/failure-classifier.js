// Failure-recovery summary builder. Given a failed run's raw events +
// diagnostics, produce a compact human-readable recap that the watcher
// can post as a system comment so the next run starts with context about
// the previous attempt's tool actions, changed files, and error text.

function toolBlocksFromRunEvents(events = []) {
  const blocks = [];
  for (const wrapper of Array.isArray(events) ? events : []) {
    const event = wrapper?.type === "sdk_event" && wrapper.event ? wrapper.event : wrapper;
    const content = event?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === "tool_use" || block?.type === "tool_result") blocks.push(block);
    }
  }
  return blocks;
}

export function compactRecoveryRunSummary({ runId, res, reason, providerInfo }) {
  const diagnostics = res?.diagnostics || {};
  const blocks = toolBlocksFromRunEvents(res?.events);
  const changedFiles = [];
  const actions = [];
  const failures = [];
  for (const block of blocks) {
    if (block.type === "tool_use") {
      const input = block.input || {};
      const path = input.file_path || input.path || input.command || input.pattern || "";
      actions.push(`${block.name || "tool"}${path ? `: ${String(path).slice(0, 180)}` : ""}`);
      if (["Write", "Edit"].includes(block.name) && input.file_path) changedFiles.push(input.file_path);
    }
    if (block.type === "tool_result" && block.is_error) {
      const content = typeof block.content === "string" ? block.content : JSON.stringify(block.content || {});
      failures.push(content.slice(0, 240));
    }
    const changes = block.content?.changes || block.raw_result?.changes || [];
    for (const change of Array.isArray(changes) ? changes : []) {
      if (change?.path) changedFiles.push(change.path);
    }
  }
  const largest = Array.isArray(diagnostics.largest_tool_events) ? diagnostics.largest_tool_events[0] : null;
  const broadScan = Array.isArray(diagnostics.broad_scan_events) ? diagnostics.broad_scan_events[0] : null;
  const uniqueFiles = [...new Set(changedFiles)].slice(0, 12);
  const errorText = String(res?.error || "").trim();
  const turnCount = Number(diagnostics.turn_count || diagnostics.turnCount || 0);
  const piErrorCode = diagnostics.pi_error_code || null;
  const intro = reason === "usage_limit"
    ? `Previous run \`${runId}\` hit the model context limit.`
    : reason === "schema_correction"
      ? `Previous run \`${runId}\` returned malformed Worklab result JSON.`
    : reason === "finalisation"
      ? `Previous run \`${runId}\` completed the work (last tool: ${diagnostics?.error_details?.last_tool_name || "journal_summary"}) but dropped before emitting the worklab.v2 envelope.`
    : reason === "coordinator_resume"
      ? `Previous run \`${runId}\` was drained when the coordinator restarted; resuming from the captured transcript snapshot.`
    : providerInfo?.subkind === "terminated"
      ? `Previous run \`${runId}\` was interrupted by a provider connection drop${turnCount ? ` after ${turnCount} turn(s)` : ""}${piErrorCode ? ` (${piErrorCode})` : ""}.`
      : `Previous run \`${runId}\` ended with a retryable provider error${providerInfo?.subkind ? ` (${providerInfo.subkind})` : ""}.`;
  const lines = [
    intro,
    providerInfo?.requestId ? `Provider request ID: ${providerInfo.requestId}` : "",
    errorText ? `Error: ${errorText.slice(0, 500)}` : "",
    largest ? `Largest tool payload: ${largest.tool || "unknown tool"} ${largest.role || "event"} (${largest.chars || 0} chars).` : "",
    broadScan ? `Broad scan detected: ${broadScan.tool || "tool"} ${broadScan.pattern || ""} ${broadScan.path || ""}`.trim() : "",
    uniqueFiles.length ? `Files touched before the failure:\n- ${uniqueFiles.join("\n- ")}` : "",
    failures.length ? `Tool failures before retry:\n- ${failures.join("\n- ")}` : "",
    actions.length ? `Recent tool actions:\n- ${actions.slice(-10).join("\n- ")}` : "",
  ].filter(Boolean);
  return lines.join("\n\n");
}
