const CODEX_ITEM_EVENTS = new Set(["item.started", "item.completed"]);

export function normalizeCodexItemType(type) {
  if (type === "commandExecution") return "command_execution";
  if (type === "mcpToolCall") return "mcp_tool_call";
  if (type === "fileChange") return "file_change";
  if (type === "agentMessage") return "agent_message";
  return type || "";
}

function isCompleted(raw) {
  return raw?.type === "item.completed";
}

function itemId(item, fallback) {
  return item?.id || fallback;
}

function itemStatus(item, raw) {
  return item?.status || (isCompleted(raw) ? "completed" : "in_progress");
}

function itemFailed(item) {
  const status = String(item?.status || "").toLowerCase();
  const exitCode = item?.exit_code ?? item?.exitCode;
  return Boolean(
    item?.error ||
    status === "failed" ||
    status === "errored" ||
    status === "error" ||
    (typeof exitCode === "number" && exitCode !== 0),
  );
}

function commandOutput(item) {
  return item?.aggregated_output ?? item?.aggregatedOutput ?? item?.output ?? "";
}

function mcpToolName(item) {
  return item?.server && item?.tool
    ? `mcp__${item.server}__${item.tool}`
    : item?.tool || "mcp_tool_call";
}

function mcpResultContent(item) {
  if (item?.error) return item.error;
  if (item?.result?.structuredContent != null) return item.result.structuredContent;
  if (item?.result?.structured_content != null) return item.result.structured_content;
  if (item?.result?.content != null) return item.result.content;
  return item?.result || "";
}

function fileChangePayload(raw, item, context = {}) {
  if (typeof context.fileChangePayload === "function") {
    const payload = context.fileChangePayload(raw, item);
    if (payload) return payload;
  }
  return {
    changes: Array.isArray(item.changes) ? item.changes : [],
    status: itemStatus(item, raw),
    ...(item.summary ? { summary: item.summary } : {}),
  };
}

export function normalizeCodexItemEvent(raw, context = {}) {
  if (!raw || !CODEX_ITEM_EVENTS.has(raw.type) || !raw.item) return null;
  const item = raw.item;
  const type = normalizeCodexItemType(item.type);

  if (type === "file_change") {
    const id = itemId(item, "file_change");
    const payload = fileChangePayload(raw, item, context);
    if (!isCompleted(raw)) {
      return {
        type: "assistant",
        message: { content: [{ type: "tool_use", id, name: "file_edit", input: payload }] },
      };
    }
    return {
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: id,
          content: item.error || payload,
          is_error: itemFailed(item),
        }],
      },
    };
  }

  if (type === "mcp_tool_call") {
    const id = itemId(item, `${item.server || "mcp"}:${item.tool || "tool"}`);
    if (!isCompleted(raw)) {
      return {
        type: "assistant",
        message: { content: [{ type: "tool_use", id, name: mcpToolName(item), input: item.arguments || {} }] },
      };
    }
    return {
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: id,
          content: mcpResultContent(item),
          is_error: itemFailed(item),
        }],
      },
    };
  }

  if (type === "command_execution") {
    const id = itemId(item, item.command || "command_execution");
    if (!isCompleted(raw)) {
      return {
        type: "assistant",
        message: { content: [{ type: "tool_use", id, name: "command_execution", input: { command: item.command || "" } }] },
      };
    }
    return {
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: id,
          content: commandOutput(item),
          is_error: itemFailed(item),
        }],
      },
    };
  }

  if (type === "agent_message" && isCompleted(raw) && typeof item.text === "string") {
    return { type: "assistant", message: { content: [{ type: "text", text: item.text }] } };
  }

  return null;
}
