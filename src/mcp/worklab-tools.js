import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { appendJournalEntry, appendJournalSummary, agentMemoryPath } from "../core/journal.js";

export const journalAppendSchema = z.object({ bullet: z.string().min(1, "bullet is required") });
export const journalSummarySchema = z.object({ text: z.string().min(1, "text is required") });
export const memoryReadSchema = z.object({});

export function createToolHandlers(context) {
  const { dataDir, agent, runId, taskId, taskTitle } = context;
  return {
    async journal_append(input) {
      const { bullet } = journalAppendSchema.parse(input);
      appendJournalEntry({ dataDir, agent, runId, taskId, taskTitle, bullet });
      return { ok: true };
    },
    async journal_summary(input) {
      const { text } = journalSummarySchema.parse(input);
      appendJournalSummary({ dataDir, agent, runId, text });
      return { ok: true };
    },
    async memory_read(input) {
      memoryReadSchema.parse(input);
      const path = agentMemoryPath(dataDir, agent);
      if (!existsSync(path)) return { content: "" };
      return { content: readFileSync(path, "utf8") };
    },
  };
}

export const toolDefinitions = [
  {
    name: "journal_append",
    description:
      "Append a bullet entry to this agent's JOURNAL.md. Use during task execution to record facts, decisions, and corrections.",
    inputSchema: {
      type: "object",
      properties: { bullet: { type: "string", description: "One concise bullet to append" } },
      required: ["bullet"],
    },
  },
  {
    name: "journal_summary",
    description:
      "Append a summary entry to the JOURNAL.md at the end of a task. Optional.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "memory_read",
    description:
      "Read this agent's consolidated MEMORY.md for Procedures / Facts / Gotchas.",
    inputSchema: { type: "object", properties: {} },
  },
];
