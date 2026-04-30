// KB-publisher helpers. Two responsibilities:
//
//   1. Build the canonical Worklab-KB entry that mirrors a run's rich final
//      answer (slug / tags / title / body / link helpers).
//   2. Detect whether the run already wrote a KB entry through Worklab's
//      kb_create / kb_update tools, so the watcher can avoid double-writing.
//
// Pure functions; no DB access. The watcher's outer loop calls these and
// then dispatches kbCreate / kbUpdate via core/kb.js.

import { slugify } from "../../core/slugs.js";

const KB_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KNOWLEDGE_LINK_RE = /#\/knowledge\/([a-z0-9]+(?:-[a-z0-9]+)*)/g;

function safeParseJson(value, fallback) {
  try {
    const parsed = JSON.parse(value || "");
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

export function runResultKbSlug(runId) {
  return slugify(`run-${runId}`, "run-result");
}

export function runResultKbTags({ task, stage, agentName }) {
  const taskRef = task?.task_key || task?.id || "task";
  return [
    "run-result",
    `task-${slugify(taskRef, "task")}`,
    slugify(stage || "run", "run"),
    `agent-${slugify(agentName || "agent", "agent")}`,
  ];
}

export function runResultKbTitle({ task, agentName }) {
  const taskRef = task?.task_key || task?.title || "Task";
  return `${taskRef} final answer${agentName ? ` from ${agentName}` : ""}`;
}

export function runResultKbBody({ task, runId, stage, agentName, richText }) {
  const taskRef = task?.task_key || task?.id || "task";
  const taskTitle = task?.title ? ` - ${task.title}` : "";
  return [
    `Source task: [${taskRef}${taskTitle}](#/tasks/${encodeURIComponent(taskRef)})`,
    `Source run: [${runId}](/api/runs/${encodeURIComponent(runId)}/raw-log)`,
    `Stage: ${stage || "execute"}`,
    `Agent: ${agentName || "agent"}`,
    "",
    "---",
    "",
    richText,
  ].join("\n");
}

export function appendKbLink(body, slug) {
  const clean = String(body || "").trim();
  const link = `Full final answer: [Knowledge entry](#/knowledge/${slug})`;
  if (!clean) return link;
  if (clean.includes(`#/knowledge/${slug}`)) return clean;
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

function validKbSlug(value) {
  const slug = String(value || "").trim();
  return KB_SLUG_RE.test(slug) ? slug : null;
}

function slugFromToolPayload(value) {
  const parsed = parseMaybeJson(value) || value;
  if (!parsed || typeof parsed !== "object") return null;
  return validKbSlug(parsed.slug || parsed.input?.slug || parsed.result?.slug);
}

function isWorklabKbWriteTool(name) {
  return name === "kb_create"
    || name === "kb_update"
    || name === "worklab_kb_create"
    || name === "worklab_kb_update"
    || /^mcp__worklab__kb_(create|update)$/.test(String(name || ""));
}

function eventContentBlocks(wrapper) {
  const event = wrapper?.type === "sdk_event" && wrapper.event ? wrapper.event : wrapper;
  if (event?.type === "tool_result") return [event];
  const content = event?.message?.content;
  if (Array.isArray(content)) return content;
  return [];
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
    for (const block of eventContentBlocks(wrapper)) {
      if (block?.type === "tool_use" && isWorklabKbWriteTool(block.name)) {
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
