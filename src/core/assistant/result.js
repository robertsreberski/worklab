import { z } from "zod";

export const ASSISTANT_RESULT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    schema: { type: "string", const: "worklab.assistant.v1" },
    reply_text: { type: "string" },
    summary: { type: "string" },
    journal_bullets: { type: "array", items: { type: "string" } },
    memory_facts: { type: "array", items: { type: "string" } },
    action_items: { type: "array", items: { type: "string" } },
  },
  required: ["schema", "reply_text", "summary", "journal_bullets", "memory_facts", "action_items"],
};

const assistantResultSchema = z.object({
  schema: z.literal("worklab.assistant.v1"),
  reply_text: z.string().default(""),
  summary: z.string().min(1),
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
    throw new Error("Assistant did not return a JSON object");
  }
}

function cleanArray(values) {
  return (values || []).map((value) => String(value || "").trim()).filter(Boolean);
}

function normalizeAssistantResult(value) {
  const parsed = assistantResultSchema.parse(value);
  const summary = parsed.summary.trim();
  return {
    ...parsed,
    reply_text: parsed.reply_text.trim() || summary,
    summary,
    journal_bullets: cleanArray(parsed.journal_bullets),
    memory_facts: cleanArray(parsed.memory_facts),
    action_items: cleanArray(parsed.action_items),
  };
}

export function parseAssistantResult(text) {
  return normalizeAssistantResult(extractJson(text));
}

export function parseAssistantStructuredResult(value) {
  try {
    return normalizeAssistantResult(value);
  } catch (err) {
    throw new Error(`Assistant structured result is invalid: ${err?.message || String(err)}`);
  }
}

export function fallbackAssistantResult(text, error) {
  const reply = String(text || "").trim() || "I could not produce a usable response.";
  return {
    schema: "worklab.assistant.v1",
    reply_text: reply,
    summary: reply.slice(0, 500),
    journal_bullets: [],
    memory_facts: [],
    action_items: [],
    parse_error: error?.message || String(error || "unstructured response"),
  };
}
