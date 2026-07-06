function jsonString(value) {
  try { return JSON.stringify(value); } catch { return String(value ?? ""); }
}

function base64Bytes(data) {
  const text = String(data || "");
  if (!text) return 0;
  const clean = text.includes(",") ? text.slice(text.indexOf(",") + 1) : text;
  return Math.floor(clean.length * 0.75);
}

function textPart(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return String(value ?? "");
  if (typeof value.text === "string") return value.text;
  if (typeof value.thinking === "string") return value.thinking;
  if (value.type === "image") return `[image ${base64Bytes(value.data)} bytes]`;
  if (value.type === "toolCall") return `${value.name || "tool"} ${jsonString(value.arguments || value.input || {})}`;
  return jsonString(value);
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(textPart).join("\n");
  return textPart(content);
}

function messageText(message) {
  if (!message) return "";
  const base = contentText(message.content);
  if (message.role === "toolResult") {
    return [
      `Tool result: ${message.toolName || "unknown"}`,
      message.isError ? "Status: error" : "",
      base,
      message.details ? jsonString(message.details) : "",
    ].filter(Boolean).join("\n");
  }
  return base;
}

export function estimateAgentMessageTokens(message) {
  const text = messageText(message);
  let chars = text.length + 12;
  let imageBytes = 0;
  const parts = Array.isArray(message?.content) ? message.content : [];
  for (const part of parts) {
    if (part?.type === "image") imageBytes += base64Bytes(part.data);
  }
  const tokens = Math.ceil(chars / 4) + Math.ceil(imageBytes / 3);
  return { tokens, chars, imageBytes };
}

export function estimateAgentMessages(messages = []) {
  return messages.reduce((acc, message) => {
    const next = estimateAgentMessageTokens(message);
    acc.tokens += next.tokens;
    acc.chars += next.chars;
    acc.imageBytes += next.imageBytes;
    return acc;
  }, { tokens: 0, chars: 0, imageBytes: 0 });
}

export function estimateFirstTurnInput({ systemPrompt = "", messages = [] } = {}) {
  const overheadChars = String(systemPrompt || "").length;
  const overheadTokens = Math.ceil(overheadChars / 4);
  const messageEstimate = estimateAgentMessages(messages);
  return {
    overheadTokens,
    overheadChars,
    inputTokens: overheadTokens + messageEstimate.tokens,
    inputChars: overheadChars + messageEstimate.chars,
  };
}
