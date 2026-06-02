// KB-publisher helpers detect whether a run already wrote a KB entry through
// Worklab's kb_create / kb_update tools, so the watcher can avoid double-writing.

import { safeParseJson } from "./run-handler.js";

const KB_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KNOWLEDGE_LINK_RE = /#\/knowledge\/([a-z0-9]+(?:-[a-z0-9]+)*)/g;

export function appendKbLink(body, slug) {
  const clean = String(body || "").trim();
  const link = `Full final answer: [Knowledge entry](#/library/knowledge/${slug})`;
  if (!clean) return link;
  if (clean.includes(`#/library/knowledge/${slug}`)) return clean;
  return `${clean}\n\n${link}`;
}

export function firstKnowledgeSlugFromText(text) {
  const body = String(text || "");
  KNOWLEDGE_LINK_RE.lastIndex = 0;
  const match = KNOWLEDGE_LINK_RE.exec(body);
  return match?.[1] || null;
}

function parseMaybeJson(value) {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text || !/^[{[]/.test(text)) return null;
    return safeParseJson(text, null);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item?.type === "text") {
        const parsed = parseMaybeJson(item.text);
        if (parsed) return parsed;
      }
    }
    return null;
  }
  if (value && typeof value === "object") return value;
  return null;
}

function slugFromToolPayload(value) {
  const parsed = parseMaybeJson(value) || value;
  if (!parsed || typeof parsed !== "object") return null;
  const slug = String(parsed.slug || parsed.input?.slug || parsed.result?.slug || "").trim();
  return KB_SLUG_RE.test(slug) ? slug : null;
}

function toolResultSucceeded(block) {
  if (block?.is_error || block?.isError) return false;
  const parsed = parseMaybeJson(block?.content ?? block?.output ?? block?.result);
  if (parsed && typeof parsed === "object") {
    if (parsed.ok === false || parsed.error) return false;
  }
  return true;
}

export function successfulKbWriteFromEvents(events = []) {
  const calls = new Map();
  for (const wrapper of Array.isArray(events) ? events : []) {
    const event = wrapper?.type === "sdk_event" && wrapper.event ? wrapper.event : wrapper;
    const blocks = event?.type === "tool_result"
      ? [event]
      : Array.isArray(event?.message?.content)
        ? event.message.content
        : [];
    for (const block of blocks) {
      if (
        block?.type === "tool_use"
        && (
          block.name === "kb_create"
          || block.name === "kb_update"
          || block.name === "worklab_kb_create"
          || block.name === "worklab_kb_update"
          || /^mcp__worklab__kb_(create|update)$/.test(String(block.name || ""))
        )
      ) {
        const id = block.id || block.tool_use_id;
        if (id) calls.set(id, { slug: slugFromToolPayload(block.input || block.arguments) });
        continue;
      }
      if (block?.type !== "tool_result" || !toolResultSucceeded(block)) continue;
      const call = calls.get(block.tool_use_id || block.id);
      if (!call) continue;
      return {
        wrote: true,
        slug: slugFromToolPayload(block.content ?? block.output ?? block.result) || call.slug,
      };
    }
  }
  return { wrote: false, slug: null };
}
