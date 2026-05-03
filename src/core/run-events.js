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

function coalescibleKind(block, { direct = false } = {}) {
  if (!block || typeof block !== "object") return null;
  if (block.type !== "thinking" && (direct || block.type !== "text")) return null;
  const text = block.text || block.thinking || block.content || "";
  return String(text).trim() ? block.type : null;
}

function eventPieces(event, eventIndex) {
  const target = eventTarget(event);
  const pieces = [];
  const addToolKey = (id) => {
    if (id) pieces.push({ key: `tool:${id}`, eventIndex });
  };

  addToolKey(toolIdFromCodexItem(target));
  addToolKey(toolIdFromBlock(target));

  const blocks = contentBlocks(event);
  blocks.forEach((block) => {
    const toolId = toolIdFromBlock(block);
    if (toolId) {
      pieces.push({ key: `tool:${toolId}`, eventIndex });
      return;
    }
    const kind = coalescibleKind(block);
    if (kind) pieces.push({ coalescibleKind: kind, eventIndex });
    else pieces.push({ key: `event:${eventIndex}:block:${pieces.length}`, eventIndex });
  });

  if (!pieces.length) {
    const kind = coalescibleKind(target, { direct: true });
    pieces.push(kind ? { coalescibleKind: kind, eventIndex } : { key: `event:${eventIndex}`, eventIndex });
  }
  return pieces;
}

function eventOrder(event, index) {
  const seq = Number(event?._event_seq);
  return Number.isFinite(seq) ? seq : index + 1;
}

function ensureUnit(units, key, order, index) {
  let unit = units.get(key);
  if (!unit) {
    unit = { key, latestOrder: order, latestIndex: index, eventIndexes: new Set() };
    units.set(key, unit);
  }
  unit.latestOrder = Math.max(unit.latestOrder, order);
  unit.latestIndex = Math.max(unit.latestIndex, index);
  unit.eventIndexes.add(index);
  return unit;
}

export function tailRunEventsByVisibleItems(events = [], limit = null) {
  if (limit === null) return events;
  const parsed = Number(limit);
  if (!Number.isFinite(parsed) || parsed < 1 || events.length <= parsed) return events;

  const units = new Map();
  let currentCoalesced = null;
  let coalescedIndex = 0;
  events.forEach((event, index) => {
    const order = eventOrder(event, index);
    for (const piece of eventPieces(event, index)) {
      let key = piece.key;
      if (piece.coalescibleKind) {
        if (currentCoalesced?.kind !== piece.coalescibleKind) {
          currentCoalesced = {
            kind: piece.coalescibleKind,
            key: `coalesced:${piece.coalescibleKind}:${coalescedIndex}`,
          };
          coalescedIndex += 1;
        }
        key = currentCoalesced.key;
      } else {
        currentCoalesced = null;
      }
      ensureUnit(units, key, order, index);
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
          r.process_status, r.failure_kind, r.error_text, r.started_at, r.ended_at,
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
    startedAt: row?.started_at || fallback.startedAt || null,
    endedAt: row?.ended_at || fallback.endedAt || null,
  };
}
