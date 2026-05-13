// Tool-result bloat containment.
//
// Single tool_result payloads can reach several megabytes and frequently trip
// the context_bloat warning. This module caps tool_result payloads before they
// reach the model and substitutes a compact reference text so the agent can
// still cite the artifact.
//
// Persistence is delegated to the host via a `persistArtifact({ filename, buffer,
// toolName, toolUseId }) -> path | null` callback. Worklab's createToolOutputSink
// in src/core/tool-artifacts.js writes to {runArtifactDir}/tool-output/<file>.
// Hosts that don't care can pass null and the truncated payload is dropped.

export const MAX_TOOL_RESULT_BYTES = 262144;

export const BINARY_BLOAT_TOOLS = Object.freeze([
  "mcp__playwright__browser_take_screenshot",
  "mcp__playwright__browser_snapshot",
]);

export const DEFAULT_TOOL_BLOAT_CONFIG = Object.freeze({
  maxBytes: MAX_TOOL_RESULT_BYTES,
  binaryBloatTools: BINARY_BLOAT_TOOLS,
});

function blockBytes(block) {
  if (!block || typeof block !== "object") return 0;
  if (block.type === "text") return Buffer.byteLength(String(block.text || ""), "utf8");
  if (block.type === "image") {
    const data = String(block.data || "");
    const clean = data.includes(",") ? data.slice(data.indexOf(",") + 1) : data;
    return Math.floor(clean.length * 0.75);
  }
  try { return Buffer.byteLength(JSON.stringify(block), "utf8"); } catch { return 0; }
}

function totalBytes(blocks) {
  if (!Array.isArray(blocks)) return 0;
  return blocks.reduce((sum, block) => sum + blockBytes(block), 0);
}

function safeBasename(name) {
  return String(name || "tool").replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 80);
}

function imageExtension(block) {
  const mime = block?.mimeType || block?.mime_type || "";
  const m = /image\/([a-z0-9]+)/i.exec(mime);
  return m ? `.${m[1].toLowerCase()}` : ".bin";
}

function persistBlock(toolName, block, idx, idTag, persistArtifact) {
  if (typeof persistArtifact !== "function" || !block || typeof block !== "object") return null;
  let filename;
  let buffer;
  if (block.type === "image") {
    filename = `${safeBasename(toolName)}__${idTag}__${idx}${imageExtension(block)}`;
    const data = String(block.data || "");
    const clean = data.includes(",") ? data.slice(data.indexOf(",") + 1) : data;
    buffer = Buffer.from(clean, "base64");
  } else {
    const text = block.type === "text"
      ? String(block.text || "")
      : (() => {
          try { return JSON.stringify(block, null, 2); } catch { return String(block); }
        })();
    filename = `${safeBasename(toolName)}__${idTag}__${idx}.txt`;
    buffer = Buffer.from(text, "utf8");
  }
  try {
    const path = persistArtifact({ filename, buffer, toolName, toolUseId: idTag });
    return typeof path === "string" && path.length ? path : null;
  } catch {
    return null;
  }
}

function summaryText(toolName, originalBytes, maxBytes, savedPaths) {
  const parts = [
    `[truncated tool_result: ${originalBytes} bytes exceeded ${maxBytes} byte cap`,
    `tool=${toolName}`,
  ];
  if (savedPaths.length === 1) parts.push(`saved_to=${savedPaths[0]}`);
  else if (savedPaths.length > 1) parts.push(`saved_to=[${savedPaths.length} files]`);
  else parts.push("persistence unavailable");
  return `${parts.join("; ")}]`;
}

export function summarisePayload(toolName, contentBlocks, persistArtifact, options = {}) {
  const {
    maxBytes = MAX_TOOL_RESULT_BYTES,
    toolUseId = null,
    now = Date.now,
  } = options;
  const blocks = Array.isArray(contentBlocks) ? contentBlocks : [];
  const originalBytes = totalBytes(blocks);
  if (originalBytes <= maxBytes) {
    return { rewrittenBlocks: blocks, savedPaths: [], originalBytes, truncated: false };
  }

  const stamp = String(now()).slice(-10);
  const idTag = toolUseId ? safeBasename(toolUseId) : `payload-${stamp}`;
  const savedPaths = [];
  blocks.forEach((block, idx) => {
    const path = persistBlock(toolName, block, idx, idTag, persistArtifact);
    if (path) savedPaths.push(path);
  });
  return {
    rewrittenBlocks: [{ type: "text", text: summaryText(toolName, originalBytes, maxBytes, savedPaths) }],
    savedPaths,
    originalBytes,
    truncated: true,
  };
}

export async function applyToolBloatGuard(toolName, executePromise, options = {}) {
  const {
    persistArtifact = null,
    toolUseId = null,
    maxBytes = MAX_TOOL_RESULT_BYTES,
    onTruncate = null,
  } = options;
  const result = await executePromise;
  if (!result || typeof result !== "object" || !Array.isArray(result.content)) return result;
  const summary = summarisePayload(toolName, result.content, persistArtifact, { maxBytes, toolUseId });
  if (!summary.truncated) return result;
  if (typeof onTruncate === "function") {
    try {
      onTruncate({
        tool: toolName,
        tool_use_id: toolUseId,
        original_bytes: summary.originalBytes,
        max_bytes: maxBytes,
        saved_paths: summary.savedPaths,
      });
    } catch { /* best-effort */ }
  }
  return {
    ...result,
    content: summary.rewrittenBlocks,
    details: {
      ...(result.details || {}),
      tool_payload_truncated: true,
      tool_payload_original_bytes: summary.originalBytes,
      tool_payload_saved_paths: summary.savedPaths,
    },
  };
}

export function wrapToolsWithBloatGuard(tools, options = {}) {
  const list = Array.isArray(tools) ? tools : [];
  return list.map((tool) => {
    if (!tool || typeof tool.execute !== "function") return tool;
    const originalExecute = tool.execute.bind(tool);
    return {
      ...tool,
      async execute(toolCallId, params, signal) {
        return applyToolBloatGuard(tool.name, originalExecute(toolCallId, params, signal), {
          ...options,
          toolUseId: toolCallId,
        });
      },
    };
  });
}
