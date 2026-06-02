// Final-text builders consume structured worklab_result data plus the run's
// raw event stream and produce the final task comment body.

import { formatWorklabResultText, stripWorklabResultJson } from "../../core/worklab-result/contract.js";

function collapseDuplicateParagraphs(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const paragraphs = raw.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  if (paragraphs.length <= 1) return raw;
  const seen = new Set();
  return paragraphs.filter((paragraph) => {
    const key = paragraph.replace(/\s+/g, " ");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join("\n\n");
}

export function sanitizeAgentText(text) {
  return collapseDuplicateParagraphs(stripWorklabResultJson(text));
}

export function agentCommentBody(result, finalText) {
  const value = result?.worklab_result || result;
  const structured = value?.schema === "worklab.v2" ? sanitizeAgentText(value.final_text || "") : "";
  if (structured) return structured;
  const delivered = sanitizeAgentText(finalText);
  if (delivered) return delivered;
  return sanitizeAgentText(formatWorklabResultText(result));
}

export function assistantTextsFromEvents(events = []) {
  const texts = [];
  for (const wrapper of Array.isArray(events) ? events : []) {
    const event = wrapper?.type === "sdk_event" && wrapper.event ? wrapper.event : wrapper;
    const content = event?.message?.content;
    if (typeof content === "string") {
      texts.push(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
    }
  }
  return texts;
}
