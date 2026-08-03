const ACP_PLAN_UPDATE_TYPES = new Set(["plan", "plan_update", "plan_removed"]);

export const WORKLAB_ACP_COMPANION_FIELD = "_worklab_acp_companion";
export const WORKLAB_ACP_PROJECTED_FIELD = "_worklab_acp_projected";

function eventTarget(event) {
  return event?.type === "sdk_event" && event.event ? event.event : event;
}

function contentBlocks(event) {
  const target = eventTarget(event);
  if (Array.isArray(target?.message?.content)) return target.message.content;
  if (Array.isArray(target?.content)) return target.content;
  return [];
}

function updateBody(event) {
  const target = eventTarget(event);
  if (target?.type !== "acp_session_update") return null;
  const candidate = target.update;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  return candidate.update?.sessionUpdate ? candidate.update : candidate;
}

function boundedText(value, max = 500) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .slice(0, max);
}

function identifier(value, max = 128) {
  return boundedText(value, max).replace(/[^a-zA-Z0-9._:-]/gu, "");
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function safeCost(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const amount = finiteNumber(value.amount);
  if (amount == null) return null;
  const currency = identifier(value.currency, 16);
  return { amount, ...(currency ? { currency } : {}) };
}

function safePlanEntries(update) {
  const candidates = Array.isArray(update?.entries)
    ? update.entries
    : Array.isArray(update?.plan?.entries)
      ? update.plan.entries
      : Array.isArray(update?.plan)
        ? update.plan
        : update?.entry
          ? [update.entry]
          : [];
  return candidates.slice(0, 50).map((entry) => {
    const content = boundedText(entry?.content, 2_000);
    const priority = identifier(entry?.priority, 32);
    const status = identifier(entry?.status, 32);
    return {
      ...(content ? { content } : {}),
      ...(priority ? { priority } : {}),
      ...(status ? { status } : {}),
    };
  }).filter((entry) => Object.keys(entry).length > 0);
}

function safeUpdateBody(updateType, update = {}) {
  if (ACP_PLAN_UPDATE_TYPES.has(updateType)) {
    return {
      sessionUpdate: updateType,
      entries: safePlanEntries(update),
    };
  }
  if (updateType === "usage_update") {
    const used = finiteNumber(update.used);
    const size = finiteNumber(update.size ?? update.window);
    const cost = safeCost(update.cost);
    return {
      sessionUpdate: updateType,
      ...(used != null ? { used } : {}),
      ...(size != null ? { size } : {}),
      ...(cost != null ? { cost } : {}),
    };
  }
  if (updateType === "available_commands_update") {
    const candidates = Array.isArray(update.availableCommands)
      ? update.availableCommands
      : Array.isArray(update.commands)
        ? update.commands
        : [];
    return {
      sessionUpdate: updateType,
      availableCommands: candidates.slice(0, 50).map((command) => ({
        name: boundedText(command?.name, 160),
        description: boundedText(command?.description, 300),
        input: { hint: boundedText(command?.input?.hint || command?.inputHint, 160) },
      })),
    };
  }
  if (updateType === "current_mode_update") {
    const currentModeId = identifier(update.currentModeId || update.modeId, 160);
    return { sessionUpdate: updateType, ...(currentModeId ? { currentModeId } : {}) };
  }
  if (updateType === "config_option_update") {
    const options = Array.isArray(update.configOptions) ? update.configOptions : [];
    return {
      sessionUpdate: updateType,
      configOptions: options.slice(0, 50).map((option) => ({
        id: boundedText(option?.id, 160),
        name: boundedText(option?.name || option?.label, 160),
        type: identifier(option?.type, 32),
      })),
    };
  }
  if (updateType === "session_info_update") {
    const title = boundedText(update.title, 300);
    const updatedAt = boundedText(update.updatedAt, 80);
    return {
      sessionUpdate: updateType,
      ...(title ? { title } : {}),
      ...(updatedAt ? { updatedAt } : {}),
    };
  }
  return { sessionUpdate: updateType };
}

function projectedSessionUpdate(update, displayKey) {
  return {
    type: "acp_session_update",
    update,
    [WORKLAB_ACP_PROJECTED_FIELD]: true,
    _worklab_display_key: displayKey,
  };
}

function withCompanionMarker(event) {
  return {
    ...event,
    [WORKLAB_ACP_COMPANION_FIELD]: true,
  };
}

function expectedCompanion(updateType, update) {
  if (updateType === "agent_message_chunk") return { kind: "message" };
  if (updateType === "agent_thought_chunk") return { kind: "thought" };
  if (updateType === "tool_call") {
    return { kind: "tool_call", toolCallId: String(update.toolCallId || "") };
  }
  if (updateType === "tool_call_update" && ["completed", "failed"].includes(update.status)) {
    return { kind: "tool_result", toolCallId: String(update.toolCallId || "") };
  }
  if (updateType === "usage_update") return { kind: "usage" };
  if (ACP_PLAN_UPDATE_TYPES.has(updateType)) return { kind: "plan" };
  return null;
}

function isMatchingCompanion(event, expected) {
  if (!expected) return false;
  const target = eventTarget(event);
  const blocks = contentBlocks(event);
  if (expected.kind === "message") {
    return target?.type === "assistant" && Array.isArray(target?.message?.content || target?.content);
  }
  if (expected.kind === "thought") {
    return target?.type === "assistant" && blocks.some((block) => block?.type === "thinking");
  }
  if (expected.kind === "tool_call") {
    return target?.type === "assistant" && blocks.some((block) => (
      block?.type === "tool_use" && String(block.id || block.tool_use_id || "") === expected.toolCallId
    ));
  }
  if (expected.kind === "tool_result") {
    return target?.type === "user" && blocks.some((block) => (
      block?.type === "tool_result" && String(block.tool_use_id || block.id || "") === expected.toolCallId
    ));
  }
  if (expected.kind === "usage") return target?.type === "context_usage" && target.source === "acp";
  if (expected.kind === "plan") return target?.type === "plan" && target.source === "acp";
  return false;
}

function appendBoundedText(state, chunk, limit) {
  if (state.truncated) return false;
  const room = Math.max(0, limit - state.text.length);
  state.text += chunk.slice(0, room);
  if (chunk.length > room) state.truncated = true;
  return chunk.length > 0;
}

/**
 * Produces the safe, bounded display projection for an ACP stdout stream while
 * preserving the original sanitized events for the explicit raw log.
 */
export function createAcpDisplayProjection({ textLimit = 12_000 } = {}) {
  const messageTextLimit = Math.max(1_000, Number(textLimit) || 12_000);
  const toolStates = new Map();
  let pendingCompanion = null;
  let currentMessage = null;
  let lastRawUpdateType = null;
  let displaySequence = 0;

  const nextDisplayKey = (kind) => `acp:${kind}:${++displaySequence}`;

  function project(rawEvent) {
    const body = updateBody(rawEvent);
    if (!body) {
      if (isMatchingCompanion(rawEvent, pendingCompanion)) {
        pendingCompanion = null;
        return { rawEvent: withCompanionMarker(rawEvent), suppressDisplay: true };
      }
      pendingCompanion = null;
      lastRawUpdateType = null;
      return { rawEvent };
    }

    const updateType = identifier(body.sessionUpdate, 128) || "unknown";
    pendingCompanion = expectedCompanion(updateType, body);

    if (updateType === "agent_message_chunk") {
      const messageId = typeof body.messageId === "string" ? body.messageId : null;
      if (!currentMessage || (messageId && currentMessage.messageId !== messageId)) {
        currentMessage = {
          key: nextDisplayKey("message"),
          messageId,
          text: "",
          truncated: false,
        };
      }
      lastRawUpdateType = updateType;
      if (body.content?.type !== "text" || typeof body.content.text !== "string") {
        return { rawEvent, suppressDisplay: true };
      }
      const changed = appendBoundedText(currentMessage, body.content.text, messageTextLimit);
      if (!changed) return { rawEvent, suppressDisplay: true };
      const text = currentMessage.truncated
        ? `${currentMessage.text}\n\n[truncated; full raw log available]`
        : currentMessage.text;
      return {
        rawEvent,
        displayKey: currentMessage.key,
        displayEvent: projectedSessionUpdate({
          sessionUpdate: updateType,
          messageId: currentMessage.key,
          content: { type: "text", text },
        }, currentMessage.key),
      };
    }

    if (updateType === "agent_thought_chunk") {
      const sameBurst = lastRawUpdateType === updateType;
      lastRawUpdateType = updateType;
      if (sameBurst) return { rawEvent, suppressDisplay: true };
      const key = nextDisplayKey("activity");
      return {
        rawEvent,
        displayKey: key,
        displayEvent: projectedSessionUpdate({ sessionUpdate: updateType }, key),
      };
    }

    if (updateType === "user_message_chunk") {
      currentMessage = null;
      lastRawUpdateType = updateType;
      return { rawEvent, suppressDisplay: true };
    }

    if (updateType === "tool_call" || updateType === "tool_call_update") {
      lastRawUpdateType = updateType;
      const toolCallId = String(body.toolCallId || "");
      const previous = toolStates.get(toolCallId) || {
        key: nextDisplayKey("tool"),
        title: "",
        kind: "",
        status: "",
      };
      const state = {
        ...previous,
        title: boundedText(body.title || body.name, 200) || previous.title,
        kind: identifier(body.kind, 64) || previous.kind,
        status: identifier(body.status, 64) || previous.status,
      };
      if (toolCallId) toolStates.set(toolCallId, state);
      return {
        rawEvent,
        displayKey: state.key,
        displayEvent: projectedSessionUpdate({
          sessionUpdate: updateType,
          toolCallId: state.key,
          ...(state.title ? { title: state.title } : {}),
          ...(state.kind ? { kind: state.kind } : {}),
          ...(state.status ? { status: state.status } : {}),
        }, state.key),
      };
    }

    lastRawUpdateType = updateType;
    const key = ACP_PLAN_UPDATE_TYPES.has(updateType)
      ? "acp:plan"
      : updateType === "usage_update"
        ? "acp:usage"
        : nextDisplayKey(updateType);
    return {
      rawEvent,
      displayKey: key,
      displayEvent: projectedSessionUpdate(safeUpdateBody(updateType, body), key),
    };
  }

  return { project };
}
