// Journal / memory / run-log tools exposed inside an agent run.

import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { withDb } from "./shared.js";
import {
  agentMemoryPath,
  appendJournalEntry,
  appendJournalSummary,
  readRunLog,
  search,
  searchAgentMemories,
} from "../../../core/index.js";

export const journalAppendSchema = z.object({ bullet: z.string().min(1, "bullet is required") });
export const journalSummarySchema = z.object({ text: z.string().min(1, "text is required") });
export const memoryReadSchema = z.object({});
export const runLogReadSchema = z.object({
  run_id: z.string().min(1, "run_id is required"),
  mode: z.enum(["summary", "tail", "full"]).optional(),
  limit_bytes: z.number().int().min(1000).max(5 * 1024 * 1024).optional(),
});

const searchSchema = z.object({
  query: z.string().min(1, "query is required"),
  limit: z.number().int().min(1).max(50).optional(),
});

export const journalSearchSchema = searchSchema.extend({ agent: z.string().optional() });
export const memorySearchSchema = searchSchema.extend({ agent: z.string().optional() });

export const definitions = [
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
  {
    name: "run_log_read",
    description:
      "Read a compact diagnostic summary for a prior Worklab run on demand. Use mode='tail' for raw JSONL tails and mode='full' only when the complete raw log is required.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string", description: "Task run id to inspect" },
        mode: { type: "string", enum: ["summary", "tail", "full"], description: "Default summary. Tail/full return raw JSONL and can be large." },
        limit_bytes: { type: "number", minimum: 1000, maximum: 5242880, description: "Tail or summary byte budget. Default 60000." },
      },
      required: ["run_id"],
    },
  },
  {
    name: "journal_search",
    description: "Search agent journals with hybrid FTS/semantic search. Optionally scope to one agent.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        agent: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 50 },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_search",
    description: "Search consolidated agent memories with hybrid FTS/semantic search. Optionally scope to one agent.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        agent: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 50 },
      },
      required: ["query"],
    },
  },
];

export function buildHandlers(context) {
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
    async run_log_read(input) {
      const { run_id: targetRunId, mode, limit_bytes } = runLogReadSchema.parse(input);
      return await withDb(dataDir, (db) => readRunLog({
        db,
        dataDir,
        runId: targetRunId,
        mode: mode || "summary",
        limitBytes: limit_bytes,
      }));
    },
    async journal_search(input) {
      const { query, limit, agent: targetAgent } = journalSearchSchema.parse(input);
      const results = await withDb(dataDir, (db) => search({ db, dataDir, query, kind: "journal", agent: targetAgent, limit: limit || 8 }));
      return { results };
    },
    async memory_search(input) {
      const { query, limit, agent: targetAgent } = memorySearchSchema.parse(input);
      const results = await withDb(dataDir, async (db) => {
        const capped = limit || 8;
        const indexed = await search({ db, dataDir, query, kind: "memory", agent: targetAgent, limit: capped });
        const learned = searchAgentMemories(db, { query, agentName: targetAgent || agent, limit: capped });
        return [...learned, ...indexed]
          .sort((a, b) => (b.score || 0) - (a.score || 0))
          .slice(0, capped);
      });
      return { results };
    },
  };
}
