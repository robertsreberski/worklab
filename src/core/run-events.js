function normalizedProcessStatus(run) {
  return run?.process_status || run?.processStatus || "running";
}

const CODEX_ITEM_EVENTS = new Set(["item.started", "item.completed"]);
export const SUBAGENT_ACTIVITY_ROW_LIMIT = 200;
// Legacy ACP logs store a raw update and normalized companion for every stream
// chunk. New runs use coordinator-side cumulative display upserts, but keeping
// this fallback bounded prevents old/live pre-upgrade streams from defeating
// the UI's event limit and growing quadratically.
export const ACP_LEGACY_STREAM_EVENT_LIMIT = 1_000;

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

function subagentActivity(event) {
  const target = eventTarget(event);
  return target?.type === "subagent_activity" ? target : null;
}

function isNativeSubagentParentTool(name) {
  const compact = String(name || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
  return compact === "agent"
    || compact === "task"
    || compact === "spawnagent"
    || compact === "codexspawnagent"
    || compact === "collaborationspawnagent";
}

function toolBlocks(event) {
  const target = eventTarget(event);
  const blocks = contentBlocks(event);
  return target && (target.type === "tool_use" || target.type === "toolCall")
    ? [target, ...blocks]
    : blocks;
}

function subagentTailContext(events) {
  const recognizedParentIds = new Set();
  for (const event of events) {
    for (const block of toolBlocks(event)) {
      const id = toolIdFromBlock(block);
      if (id && isNativeSubagentParentTool(block?.name)) recognizedParentIds.add(id);
    }
  }

  const groupKeyByParentId = new Map();
  const groupKeyByEventIndex = new Map();
  const activityIndexesByGroupKey = new Map();
  events.forEach((event, index) => {
    const activity = subagentActivity(event);
    if (!activity) return;
    const canonicalId = activity.subagent?.id || null;
    const legacyParentId = activity.subagent?.toolUseId || null;
    const attachedParentId = [canonicalId, legacyParentId]
      .find((id) => id && recognizedParentIds.has(id));
    const standaloneId = canonicalId || activity.subagent?.nativeId || legacyParentId || activity.id || index;
    const groupKey = `subagent:${attachedParentId || standaloneId}`;
    if (attachedParentId) groupKeyByParentId.set(attachedParentId, groupKey);
    groupKeyByEventIndex.set(index, groupKey);
    const indexes = activityIndexesByGroupKey.get(groupKey) || [];
    indexes.push(index);
    activityIndexesByGroupKey.set(groupKey, indexes);
  });

  return { groupKeyByParentId, groupKeyByEventIndex, activityIndexesByGroupKey };
}

function acpSessionUpdate(event) {
  const target = eventTarget(event);
  if (target?.type !== "acp_session_update") return null;
  const update = target.update;
  if (!update || typeof update !== "object" || Array.isArray(update)) return null;
  return update.update?.sessionUpdate ? update.update : update;
}

function acpCompanionKind(event, expected) {
  const target = eventTarget(event);
  const blocks = contentBlocks(event);
  if (expected === "message") {
    return target?.type === "assistant" && Array.isArray(target?.message?.content || target?.content);
  }
  if (expected === "thought") {
    return target?.type === "assistant" && blocks.some((block) => block?.type === "thinking");
  }
  if (expected === "tool_call") {
    return target?.type === "assistant" && blocks.some((block) => block?.type === "tool_use");
  }
  if (expected === "tool_result") {
    return target?.type === "user" && blocks.some((block) => block?.type === "tool_result");
  }
  if (expected === "usage") return target?.type === "context_usage" && target.source === "acp";
  if (expected === "plan") return target?.type === "plan" && target.source === "acp";
  return false;
}

function acpTailContext(events) {
  const keyByEventIndex = new Map();
  const maxEventsByKey = new Map();
  const rawIndexByCompanionIndex = new Map();
  let stream = null;
  let pendingCompanion = null;
  let lastRawKey = null;
  let lastRawIndex = null;
  let sequence = 0;
  const nextKey = (kind) => `acp:${kind}:${sequence++}`;

  events.forEach((event, index) => {
    const update = acpSessionUpdate(event);
    if (update) {
      const kind = String(update.sessionUpdate || "");
      if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
        const streamKind = kind === "agent_message_chunk" ? "message" : "thought";
        const messageId = streamKind === "message" && typeof update.messageId === "string"
          ? update.messageId
          : null;
        if (!stream || stream.kind !== streamKind || (messageId && stream.messageId !== messageId)) {
          stream = { kind: streamKind, messageId, key: nextKey(streamKind) };
        }
        keyByEventIndex.set(index, stream.key);
        maxEventsByKey.set(stream.key, ACP_LEGACY_STREAM_EVENT_LIMIT);
        pendingCompanion = { kind: streamKind, key: stream.key, rawIndex: index };
        lastRawKey = stream.key;
        lastRawIndex = index;
        return;
      }

      stream = null;
      const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : "";
      if ((kind === "tool_call" || kind === "tool_call_update") && toolCallId) {
        const key = `tool:${toolCallId}`;
        keyByEventIndex.set(index, key);
        pendingCompanion = {
          kind: kind === "tool_call" ? "tool_call" : "tool_result",
          key,
          rawIndex: index,
        };
        lastRawKey = key;
        lastRawIndex = index;
        return;
      }
      if (kind === "usage_update") {
        const key = nextKey("usage");
        keyByEventIndex.set(index, key);
        pendingCompanion = { kind: "usage", key, rawIndex: index };
        lastRawKey = key;
        lastRawIndex = index;
        return;
      }
      if (kind === "plan" || kind === "plan_update" || kind === "plan_removed") {
        const key = nextKey("plan");
        keyByEventIndex.set(index, key);
        pendingCompanion = { kind: "plan", key, rawIndex: index };
        lastRawKey = key;
        lastRawIndex = index;
        return;
      }
      pendingCompanion = null;
      const key = nextKey(kind || "update");
      keyByEventIndex.set(index, key);
      lastRawKey = key;
      lastRawIndex = index;
      return;
    }

    if (event?._worklab_acp_companion === true && lastRawKey) {
      keyByEventIndex.set(index, lastRawKey);
      if (lastRawIndex != null) rawIndexByCompanionIndex.set(index, lastRawIndex);
      pendingCompanion = null;
      lastRawKey = null;
      lastRawIndex = null;
      return;
    }

    if (pendingCompanion && acpCompanionKind(event, pendingCompanion.kind)) {
      keyByEventIndex.set(index, pendingCompanion.key);
      rawIndexByCompanionIndex.set(index, pendingCompanion.rawIndex);
      pendingCompanion = null;
      lastRawKey = null;
      lastRawIndex = null;
      return;
    }

    pendingCompanion = null;
    stream = null;
  });
  return { keyByEventIndex, maxEventsByKey, rawIndexByCompanionIndex };
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

function eventPieces(event, eventIndex, subagentContext, acpContext) {
  const acpKey = acpContext.keyByEventIndex.get(eventIndex);
  if (acpKey) {
    return [{
      key: acpKey,
      eventIndex,
      maxEvents: acpContext.maxEventsByKey.get(acpKey) || null,
    }];
  }
  const subagentGroupKey = subagentContext.groupKeyByEventIndex.get(eventIndex);
  if (subagentGroupKey) return [{ key: subagentGroupKey, eventIndex }];

  const target = eventTarget(event);
  const pieces = [];
  const addToolKey = (id) => {
    if (!id) return;
    pieces.push({ key: subagentContext.groupKeyByParentId.get(id) || `tool:${id}`, eventIndex });
  };

  addToolKey(toolIdFromCodexItem(target));
  addToolKey(toolIdFromBlock(target));

  const blocks = contentBlocks(event);
  blocks.forEach((block) => {
    const toolId = toolIdFromBlock(block);
    if (toolId) {
      addToolKey(toolId);
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

function internalOmittedRowCount(event) {
  const count = Number(subagentActivity(event)?._worklab_subagent_omitted_rows);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

function withInternalOmittedRowCount(event, count) {
  if (!(count > 0)) return event;
  if (event?.type === "sdk_event" && event.event) {
    return { ...event, event: { ...event.event, _worklab_subagent_omitted_rows: count } };
  }
  if (event?.type === "cli_event" && event.raw) {
    return { ...event, raw: { ...event.raw, _worklab_subagent_omitted_rows: count } };
  }
  return { ...event, _worklab_subagent_omitted_rows: count };
}

function capSelectedSubagentRows(events, selectedIndexes, subagentContext) {
  const replacements = new Map();
  for (const indexes of subagentContext.activityIndexesByGroupKey.values()) {
    const selectedActivityIndexes = indexes.filter((index) => selectedIndexes.has(index));
    if (!selectedActivityIndexes.length) continue;
    const priorOmitted = selectedActivityIndexes.reduce(
      (max, index) => Math.max(max, internalOmittedRowCount(events[index])),
      0,
    );
    const bookends = selectedActivityIndexes.filter((index) => {
      const phase = subagentActivity(events[index])?.phase;
      return phase === "agent_started" || phase === "agent_completed";
    });
    const nested = selectedActivityIndexes.filter((index) => !bookends.includes(index));
    const removed = Math.max(0, nested.length - SUBAGENT_ACTIVITY_ROW_LIMIT);
    for (const index of nested.slice(0, removed)) selectedIndexes.delete(index);

    const omitted = priorOmitted + removed;
    if (!(omitted > 0)) continue;
    const markerIndex = bookends.find((index) => subagentActivity(events[index])?.phase === "agent_started")
      ?? nested.slice(removed)[0]
      ?? bookends[0];
    if (markerIndex !== undefined) {
      replacements.set(markerIndex, withInternalOmittedRowCount(events[markerIndex], omitted));
    }
  }
  return replacements;
}

function eventOrder(event, index) {
  const seq = Number(event?._event_seq);
  return Number.isFinite(seq) ? seq : index + 1;
}

function ensureUnit(units, key, order, index, maxEvents = null) {
  let unit = units.get(key);
  if (!unit) {
    unit = { key, latestOrder: order, latestIndex: index, eventIndexes: new Set(), maxEvents };
    units.set(key, unit);
  }
  unit.latestOrder = Math.max(unit.latestOrder, order);
  unit.latestIndex = Math.max(unit.latestIndex, index);
  unit.eventIndexes.add(index);
  while (unit.maxEvents && unit.eventIndexes.size > unit.maxEvents) {
    const oldest = unit.eventIndexes.values().next().value;
    if (oldest === undefined) break;
    unit.eventIndexes.delete(oldest);
  }
  return unit;
}

export function tailRunEventsByVisibleItems(events = [], limit = null) {
  if (limit === null) return events;
  const parsed = Number(limit);
  if (!Number.isFinite(parsed) || parsed < 1) return events;

  const units = new Map();
  const subagentContext = subagentTailContext(events);
  const acpContext = acpTailContext(events);
  let currentCoalesced = null;
  let coalescedIndex = 0;
  events.forEach((event, index) => {
    const order = eventOrder(event, index);
    for (const piece of eventPieces(event, index, subagentContext, acpContext)) {
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
      ensureUnit(units, key, order, index, piece.maxEvents);
    }
  });

  const selectedUnits = [...units.values()]
    .sort((a, b) => a.latestOrder - b.latestOrder || a.latestIndex - b.latestIndex)
    .slice(-parsed);
  const selectedEventIndexes = new Set();
  for (const unit of selectedUnits) {
    for (const index of unit.eventIndexes) selectedEventIndexes.add(index);
  }
  for (const [companionIndex, rawIndex] of acpContext.rawIndexByCompanionIndex) {
    if (selectedEventIndexes.has(companionIndex) === selectedEventIndexes.has(rawIndex)) continue;
    selectedEventIndexes.delete(companionIndex);
    selectedEventIndexes.delete(rawIndex);
  }
  const replacements = capSelectedSubagentRows(events, selectedEventIndexes, subagentContext);
  return events
    .map((event, index) => replacements.get(index) || event)
    .filter((_, index) => selectedEventIndexes.has(index));
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
