import { EMPTY_USAGE } from "./pi-models.js";

export function promptTextFromMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) return "";
  return messages
    .filter((message) => message?.role === "user")
    .map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? ""))
    .join("\n");
}

function messageContent(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((part) => {
      if (typeof part === "string") return { type: "text", text: part };
      if (part?.type === "text" && typeof part.text === "string") return { type: "text", text: part.text };
      if (part?.type === "image" && part.data) return { type: "image", data: part.data, mimeType: part.mimeType || part.mime_type || "image/png" };
      return { type: "text", text: JSON.stringify(part ?? "") };
    });
  }
  return String(value ?? "");
}

export function toAgentMessages(messages, model) {
  const source = Array.isArray(messages) && messages.length
    ? messages
    : [{ role: "user", content: "" }];
  return source.flatMap((message) => {
    const timestamp = message.timestamp || Date.now();
    if (message.role === "user") return [{ role: "user", content: messageContent(message.content), timestamp }];
    if (message.role === "assistant") {
      return [{
        role: "assistant",
        content: [{ type: "text", text: typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "") }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: EMPTY_USAGE,
        stopReason: "stop",
        timestamp,
      }];
    }
    if (message.role === "toolResult") return [message];
    return [];
  });
}

export function textFromContent(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

export function thinkingFromContent(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "thinking" && typeof block.thinking === "string")
    .map((block) => block.thinking)
    .join("");
}

export function toolResultContent(result) {
  const content = result?.content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => block?.type === "text" ? block.text || "" : JSON.stringify(block)).filter(Boolean).join("\n");
}
