// Final-text builders. Consume the structured worklab_result + the run's
// raw event stream and produce two text artifacts:
//
//   commentBody  — short, posted as the agent's final task comment
//   richFinal    — long-form answer (research / report) when the run produced
//                  one, distinct enough from the comment body that the UI
//                  links to it instead of inlining
//
// Pure functions; pulled out of task-watcher.js so the watcher's main
// orchestration reads as DB transitions and event broadcasts.

import { formatWorklabResultText, stripWorklabResultJson } from "../../core/worklab-result.js";

const RICH_FINAL_MIN_CHARS = 800;

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

export function structuredFinalText(result) {
  const value = result?.worklab_result || result;
  if (!value || value.schema !== "worklab.v2") return "";
  return sanitizeAgentText(value.final_text || "");
}

export function agentCommentBody(result, finalText) {
  const structured = structuredFinalText(result);
  if (structured) return structured;
  const delivered = sanitizeAgentText(finalText);
  if (delivered) return delivered;
  return sanitizeAgentText(formatWorklabResultText(result));
}

function normalizedComparableText(text) {
  return String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function firstMeaningfulParagraph(text, limit = 500) {
  const paragraph = String(text || "")
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .find(Boolean) || "";
  if (paragraph.length <= limit) return paragraph;
  return `${paragraph.slice(0, limit - 3).trimEnd()}...`;
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

function isDistinctRichFinal(text, commentBody) {
  const body = String(text || "").trim();
  if (body.length < RICH_FINAL_MIN_CHARS) return false;
  const comparableBody = normalizedComparableText(body);
  const comparableComment = normalizedComparableText(commentBody);
  if (!comparableBody) return false;
  if (comparableBody === comparableComment) return false;
  return true;
}

export function richFinalAnswerFromRun({ finalText, events, commentBody }) {
  const candidates = [
    sanitizeAgentText(finalText),
    ...assistantTextsFromEvents(events).reverse().map((text) => sanitizeAgentText(text)),
  ];
  for (const candidate of candidates) {
    if (isDistinctRichFinal(candidate, commentBody)) return candidate;
  }
  return "";
}

export function conciseCommentForLinkedAnswer(result, richText) {
  const structured = structuredFinalText(result);
  if (structured) return structured;
  const summary = sanitizeAgentText(result?.summary || "");
  if (summary) return summary;
  return firstMeaningfulParagraph(richText);
}
