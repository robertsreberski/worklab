import { z } from "zod";

export const TRIAGE_RESULT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    schema: { type: "string", const: "worklab.slack.triage.v1" },
    importance: { type: "string", enum: ["low", "normal", "high", "urgent"] },
    summary: { type: "string" },
    should_reply: { type: "boolean" },
    reply_text: { type: "string" },
    notify_user: { type: "boolean" },
    user_message: { type: "string" },
    journal_bullets: { type: "array", items: { type: "string" } },
    memory_facts: { type: "array", items: { type: "string" } },
    action_items: { type: "array", items: { type: "string" } },
  },
  required: [
    "schema",
    "importance",
    "summary",
    "should_reply",
    "reply_text",
    "notify_user",
    "user_message",
    "journal_bullets",
    "memory_facts",
    "action_items",
  ],
};

const triageResultSchema = z.object({
  schema: z.literal("worklab.slack.triage.v1"),
  importance: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  summary: z.string().min(1),
  should_reply: z.boolean().default(false),
  reply_text: z.string().default(""),
  notify_user: z.boolean().default(false),
  user_message: z.string().default(""),
  journal_bullets: z.array(z.string()).default([]),
  memory_facts: z.array(z.string()).default([]),
  action_items: z.array(z.string()).default([]),
});

function stripFence(text) {
  const value = String(text || "").trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(value);
  return match ? match[1].trim() : value;
}

function extractJson(text) {
  const unfenced = stripFence(text);
  try {
    return JSON.parse(unfenced);
  } catch {
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(unfenced.slice(start, end + 1));
    throw new Error("Slack triage did not return a JSON object");
  }
}

function cleanArray(values) {
  return (values || []).map((value) => String(value || "").trim()).filter(Boolean);
}

export function parseTriageResult(text) {
  const parsed = triageResultSchema.parse(extractJson(text));
  const out = {
    ...parsed,
    reply_text: parsed.reply_text.trim(),
    user_message: parsed.user_message.trim(),
    journal_bullets: cleanArray(parsed.journal_bullets),
    memory_facts: cleanArray(parsed.memory_facts),
    action_items: cleanArray(parsed.action_items),
  };
  if (out.should_reply && !out.reply_text) out.should_reply = false;
  if (out.notify_user && !out.user_message) out.user_message = out.summary;
  return out;
}
