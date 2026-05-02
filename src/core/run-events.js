function normalizedProcessStatus(run) {
  return run?.process_status || run?.processStatus || "running";
}

const CODEX_ITEM_EVENTS = new Set(["item.started", "item.completed"]);

function normalizeCodexItemType(type) {
  if (type === "commandExecution") return "command_execution";
  if (type === "mcpToolCall") return "mcp_tool_call";
  if (type === "fileChange") return "file_change";
  return type || "";
}

function eventTarget(event) {
  if (event?.type === "sdk_event" && event.event) return event.event;
  if (event?.type === "cli_event" && event.raw) return event.raw;
  return event;
}

function contentBlocks(event) {
  const target = eventTarget(event);
  if (Array.isArray(target?.message?.content)) return target.message.content;
  if (Array.isArray(target?.content)) return target.content;
  return [];
}

function toolIdFromBlock(block) {
  if (!block || typeof block !== "object") return null;
  const type = block.type;
  if (type === "tool_use" || type === "toolCall") {
    return block.tool_use_id || block.id || block.toolCallId || block.tool_call_id || null;
  }
  if (type === "tool_result" || type === "toolResult" || type === "tool_output") {
    return block.tool_use_id || block.id || block.toolCallId || block.tool_call_id || null;
  }
  if (type === "structured_output") {
    return block.tool_use_id || block.id || block.toolCallId || block.tool_call_id || null;
  }
  return null;
}

function toolIdFromCodexItem(raw) {
  if (!raw || !CODEX_ITEM_EVENTS.has(raw.type) || !raw.item) return null;
  const item = raw.item;
  const type = normalizeCodexItemType(item.type);
  if (type === "file_change") return item.id || "file_change";
  if (type === "mcp_tool_call") return item.id || `${item.server || "mcp"}:${item.tool || "tool"}`;
  if (type === "command_execution") return item.id || item.command || "command_execution";
  return null;
}

function visibleUnitKeys(event, eventIndex) {
  const target = eventTarget(event);
  const keys = [];
  const addToolKey = (id) => {
    if (id) keys.push(`tool:${id}`);
  };

  addToolKey(toolIdFromCodexItem(target));
  addToolKey(toolIdFromBlock(target));

  const blocks = contentBlocks(event);
  blocks.forEach((block, blockIndex) => {
    const toolId = toolIdFromBlock(block);
    if (toolId) keys.push(`tool:${toolId}`);
    else keys.push(`event:${eventIndex}:block:${blockIndex}`);
  });

  if (!keys.length) keys.push(`event:${eventIndex}`);
  return [...new Set(keys)];
}

function eventOrder(event, index) {
  const seq = Number(event?._event_seq);
  return Number.isFinite(seq) ? seq : index + 1;
}

export function tailRunEventsByVisibleItems(events = [], limit = null) {
  if (limit === null) return events;
  const parsed = Number(limit);
  if (!Number.isFinite(parsed) || parsed < 1 || events.length <= parsed) return events;

  const units = new Map();
  events.forEach((event, index) => {
    const order = eventOrder(event, index);
    for (const key of visibleUnitKeys(event, index)) {
      let unit = units.get(key);
      if (!unit) {
        unit = { key, latestOrder: order, latestIndex: index, eventIndexes: new Set() };
        units.set(key, unit);
      }
      unit.latestOrder = Math.max(unit.latestOrder, order);
      unit.latestIndex = Math.max(unit.latestIndex, index);
      unit.eventIndexes.add(index);
    }
  });

  const selectedUnits = [...units.values()]
    .sort((a, b) => a.latestOrder - b.latestOrder || a.latestIndex - b.latestIndex)
    .slice(-parsed);
  const selectedEventIndexes = new Set();
  for (const unit of selectedUnits) {
    for (const index of unit.eventIndexes) selectedEventIndexes.add(index);
  }
  return events.filter((_, index) => selectedEventIndexes.has(index));
}

export function buildRunLifecycleEvent(db, type, runId, fallback = {}) {
  const row = db && runId
    ? db.prepare(`
        SELECT
          r.id, r.task_id, r.mode, r.stage, r.agent_name, r.status,
          r.process_status, r.failure_kind, r.error_text,
          t.task_key, t.title AS task_title,
          a.display_name AS agent_display_name
        FROM task_runs r
        LEFT JOIN tasks t ON t.id = r.task_id
        LEFT JOIN agents a ON a.name = r.agent_name
        WHERE r.id = ?
      `).get(runId)
    : null;

  const status = row?.status || fallback.status || null;
  return {
    type,
    runId,
    taskId: row?.task_id || fallback.taskId || null,
    taskKey: row?.task_key || fallback.taskKey || null,
    taskTitle: row?.task_title || fallback.taskTitle || null,
    mode: row?.mode || fallback.mode || null,
    stage: row?.stage || fallback.stage || null,
    agentName: row?.agent_name || fallback.agentName || null,
    agentDisplayName: row?.agent_display_name || fallback.agentDisplayName || null,
    status,
    processStatus: normalizedProcessStatus(row || { status, processStatus: fallback.processStatus }),
    failureKind: row?.failure_kind || fallback.failureKind || null,
    errorText: row?.error_text || fallback.errorText || null,
  };
}
