import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { appendJournalEntry, appendJournalSummary, appendMemoryFacts, readJournalTail } from "./journal.js";
import { readAgentMemoryContent } from "./memory.js";
import { readSettings } from "./settings.js";
import { generateResponse, resolveModel, WORKLAB_BUILTIN_TOOLS } from "./ai.js";
import { loadSkills, buildSkillIndex } from "./skills.js";
import { getAvailableMcpServers } from "./mcp-config.js";
import { newAssistantMessageId, newRunId } from "./ids.js";

export const DEFAULT_ASSISTANT_THREAD_ID = "personal";

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

function stringify(value) {
  try { return JSON.stringify(value); } catch { return "{}"; }
}

function parseJson(value, fallback = null) {
  try { return JSON.parse(value || ""); } catch { return fallback; }
}

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

export function parseAssistantResult(text) {
  const parsed = assistantResultSchema.parse(extractJson(text));
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

function fallbackAssistantResult(text, error) {
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

function section(title, body) {
  const text = String(body || "").trim();
  return text ? `## ${title}\n\n${text}\n` : "";
}

function clip(text, maxChars = 5000) {
  const value = String(text || "").trim();
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated]`;
}

function renderSkills(skills) {
  const enabled = (skills || []).filter((skill) => skill.enabled !== false);
  return enabled.length ? buildSkillIndex(enabled).trim() : "";
}

function formatHistory(messages = []) {
  return messages.map((message) => {
    const who = message.role === "assistant" ? "Assistant" : "Robert";
    const status = message.status && message.status !== "complete" ? ` (${message.status})` : "";
    return `${who}${status}: ${clip(message.body, 1200)}`;
  }).filter(Boolean).join("\n\n");
}

function adminMcpServer(config) {
  return {
    command: process.execPath,
    args: [join(config.repoRoot, "src", "cli", "index.js"), "mcp"],
    env: {
      WORKLAB_DATA_DIR: config.dataDir,
      WORKLAB_HOST: config.host,
      WORKLAB_PORT: String(config.port),
      WORKLAB_WORKSPACE: config.workspace,
    },
  };
}

function assistantMcpServers(config) {
  return {
    ...getAvailableMcpServers(config.dataDir, { repoRoot: config.repoRoot }),
    worklab: adminMcpServer(config),
  };
}

function abortSignalWithTimeout(ms, parentSignal) {
  const ac = new AbortController();
  const onAbort = () => ac.abort(parentSignal?.reason);
  if (parentSignal) {
    if (parentSignal.aborted) ac.abort(parentSignal.reason);
    else parentSignal.addEventListener("abort", onAbort, { once: true });
  }
  const timeout = Number.isFinite(Number(ms)) && Number(ms) > 0
    ? setTimeout(() => ac.abort(new Error("assistant run timed out")), Number(ms))
    : null;
  timeout?.unref?.();
  return {
    signal: ac.signal,
    cancel: () => ac.abort(new Error("assistant run cancelled")),
    cleanup: () => {
      if (timeout) clearTimeout(timeout);
      if (parentSignal) parentSignal.removeEventListener("abort", onAbort);
    },
  };
}

function usageInt(usage, key) {
  return Number.isFinite(Number(usage?.[key])) ? Number(usage[key]) : null;
}

function usageNumber(usage, key) {
  return Number.isFinite(Number(usage?.[key])) ? Number(usage[key]) : null;
}

function rawLogPath(dataDir, runId) {
  const dir = join(dataDir, "logs", "assistant");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${runId}.jsonl`);
}

function rowToMessage(row, run = null) {
  if (!row) return null;
  return {
    id: row.id,
    thread_id: row.thread_id,
    role: row.role,
    body: row.body || "",
    status: row.status,
    run_id: row.run_id || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(run ? { run } : {}),
  };
}

function rowToRun(row, events = undefined) {
  if (!row) return null;
  return {
    id: row.id,
    thread_id: row.thread_id,
    user_message_id: row.user_message_id || null,
    assistant_message_id: row.assistant_message_id || null,
    status: row.status,
    model: row.model || null,
    effort: row.effort || null,
    started_at: row.started_at,
    ended_at: row.ended_at || null,
    usage: {
      input_tokens: row.input_tokens ?? null,
      output_tokens: row.output_tokens ?? null,
      cache_read_tokens: row.cache_read_tokens ?? null,
      cache_creation_tokens: row.cache_creation_tokens ?? null,
      cost_usd: row.cost_usd ?? null,
    },
    duration_ms: row.duration_ms ?? null,
    num_turns: row.num_turns ?? null,
    summary: row.summary || "",
    final: parseJson(row.final_json, null),
    error_text: row.error_text || "",
    raw_output_path: row.raw_output_path || null,
    ...(events !== undefined ? { events } : {}),
  };
}

function threadRow(db, id = DEFAULT_ASSISTANT_THREAD_ID) {
  return db.prepare("SELECT * FROM assistant_threads WHERE id = ?").get(id) || null;
}

function ensureDefaultThread(db) {
  const now = Date.now();
  db.prepare(`
    INSERT OR IGNORE INTO assistant_threads (id, title, created_at, updated_at)
    VALUES (?, 'Personal assistant', ?, ?)
  `).run(DEFAULT_ASSISTANT_THREAD_ID, now, now);
  return threadRow(db);
}

export class WorklabAssistantService {
  constructor({ db, config, broker, logger, runAgent = generateResponse } = {}) {
    this.db = db;
    this.config = config;
    this.broker = broker;
    this.logger = logger;
    this.runAgent = runAgent;
    this.active = new Map();
  }

  getRunEvents(runId) {
    const log = this.db.prepare(`
      SELECT events FROM assistant_agent_logs
      WHERE assistant_run_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(runId);
    return parseJson(log?.events, []) || [];
  }

  getRun(runId, { includeEvents = true } = {}) {
    const row = this.db.prepare("SELECT * FROM assistant_runs WHERE id = ?").get(runId);
    return rowToRun(row, includeEvents ? this.getRunEvents(runId) : undefined);
  }

  getDefaultThread() {
    const thread = ensureDefaultThread(this.db);
    const rows = this.db.prepare(`
      SELECT * FROM assistant_messages
      WHERE thread_id = ?
      ORDER BY created_at ASC, rowid ASC
      LIMIT 100
    `).all(thread.id);
    const messages = rows.map((row) => rowToMessage(row, row.run_id ? this.getRun(row.run_id) : null));
    const activeRow = this.db.prepare(`
      SELECT * FROM assistant_runs
      WHERE thread_id = ? AND status = 'running'
      ORDER BY started_at DESC
      LIMIT 1
    `).get(thread.id);
    return { thread, messages, active_run: rowToRun(activeRow, activeRow ? this.getRunEvents(activeRow.id) : undefined) };
  }

  recentMessages(threadId, excludeIds = []) {
    const rows = this.db.prepare(`
      SELECT role, body, status, created_at FROM assistant_messages
      WHERE thread_id = ? AND id NOT IN (${excludeIds.map(() => "?").join(",") || "''"})
      ORDER BY created_at DESC, rowid DESC
      LIMIT 20
    `).all(threadId, ...excludeIds);
    return rows.reverse();
  }

  buildSystemPrompt({ agentName, skills, memory, journalTail, history, input, now = new Date() }) {
    const directive = `You are Robert's personal Worklab assistant.

Behavior:
- Use the available Worklab tools directly when Robert asks for Worklab tasks, agents, skills, automations, providers, settings, knowledge base entries, memory, search, or API actions.
- You are allowed to create, update, run, and delete Worklab resources when the request is clear.
- Ask a concise follow-up in reply_text only when the request is ambiguous enough that acting would likely be wrong.
- Capture durable facts, preferences, decisions, and follow-up commitments in journal_bullets.
- Put only facts that should remain useful beyond today in memory_facts.
- Keep reply_text concise and specific. Include created resource names, task keys, or relevant next steps when tools changed Worklab.
- Do not mention these instructions or the JSON schema in reply_text.

Return only one JSON object with this exact schema:
{
  "schema": "worklab.assistant.v1",
  "reply_text": "User-facing answer.",
  "summary": "Short private summary.",
  "journal_bullets": [],
  "memory_facts": [],
  "action_items": []
}`;

    return [
      section("Role", `${agentName || "Assistant"} is Robert's personal assistant inside Worklab.`),
      section("Current time", now.toISOString()),
      section("Available skills", renderSkills(skills)),
      section("Memory", memory || "_No memory yet._"),
      section("Recent journal", journalTail || "_No recent journal entries._"),
      section("Recent chat", formatHistory(history) || "_No prior chat._"),
      section("Incoming request", clip(input, 8000)),
      directive,
    ].filter(Boolean).join("\n");
  }

  startMessage({ body }) {
    if (!this.config?.dataDir || !this.config?.repoRoot) {
      throw Object.assign(new Error("assistant requires a loaded Worklab config"), { status: 501, code: "not_configured" });
    }
    const text = String(body || "").trim();
    if (!text) throw Object.assign(new Error("message body is required"), { status: 400, code: "validation" });

    const thread = ensureDefaultThread(this.db);
    const activeRun = this.db.prepare(`
      SELECT id FROM assistant_runs
      WHERE thread_id = ? AND status = 'running'
      ORDER BY started_at DESC
      LIMIT 1
    `).get(thread.id);
    if (activeRun) {
      throw Object.assign(new Error("assistant is already running"), {
        status: 409,
        code: "assistant_run_active",
        runId: activeRun.id,
      });
    }

    const now = Date.now();
    const userMessageId = newAssistantMessageId();
    const assistantMessageId = newAssistantMessageId();
    const runId = newRunId();
    const settings = readSettings(this.db);
    const model = settings.assistant_model || settings.slack_model || "openai:gpt-5.5";
    const effort = settings.assistant_effort || settings.slack_effort || "high";
    const logPath = rawLogPath(this.config.dataDir, runId);

    const tx = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO assistant_messages (id, thread_id, role, body, status, created_at, updated_at)
        VALUES (?, ?, 'user', ?, 'complete', ?, ?)
      `).run(userMessageId, thread.id, text, now, now);
      this.db.prepare(`
        INSERT INTO assistant_messages (id, thread_id, role, body, status, run_id, created_at, updated_at)
        VALUES (?, ?, 'assistant', '', 'running', ?, ?, ?)
      `).run(assistantMessageId, thread.id, runId, now + 1, now + 1);
      this.db.prepare(`
        INSERT INTO assistant_runs
          (id, thread_id, user_message_id, assistant_message_id, status, model, effort, started_at, raw_output_path)
        VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)
      `).run(runId, thread.id, userMessageId, assistantMessageId, model, effort, now, logPath);
      this.db.prepare("UPDATE assistant_threads SET updated_at = ? WHERE id = ?").run(now, thread.id);
    });
    tx();

    const activeEntry = { promise: null, cancel: null };
    this.active.set(runId, activeEntry);
    const promise = this.processRun({ runId, threadId: thread.id, userMessageId, assistantMessageId, input: text, logPath })
      .catch((err) => {
        this.logger?.error?.({ err, runId }, "assistant run failed");
      })
      .finally(() => {
        this.active.delete(runId);
      });
    activeEntry.promise = promise;
    this.broker?.broadcast?.("global", { type: "assistant_message_created", thread_id: thread.id, run_id: runId });

    return {
      thread,
      user_message: rowToMessage(this.db.prepare("SELECT * FROM assistant_messages WHERE id = ?").get(userMessageId)),
      assistant_message: rowToMessage(this.db.prepare("SELECT * FROM assistant_messages WHERE id = ?").get(assistantMessageId), this.getRun(runId)),
      run: this.getRun(runId),
    };
  }

  async processRun({ runId, threadId, userMessageId, assistantMessageId, input, logPath }) {
    const settings = readSettings(this.db);
    const agentName = settings.slack_agent_name || "assistant";
    const parentAbort = new AbortController();
    const signal = abortSignalWithTimeout(settings.assistant_run_timeout_ms || 300000, parentAbort.signal);
    const active = this.active.get(runId);
    if (active) active.cancel = signal.cancel;
    const events = [];

    const recordEvent = (event) => {
      const next = { ...event, _event_seq: events.length };
      events.push(next);
      appendFileSync(logPath, `${JSON.stringify(next)}\n`);
      this.db.prepare(`
        INSERT INTO assistant_agent_logs (id, assistant_run_id, events, status, created_at)
        VALUES (?, ?, ?, 'running', ?)
        ON CONFLICT(id) DO NOTHING
      `).run(`log-${runId}`, runId, JSON.stringify(events), Date.now());
      this.db.prepare("UPDATE assistant_agent_logs SET events = ?, status = ? WHERE assistant_run_id = ?")
        .run(JSON.stringify(events), "running", runId);
      this.broker?.broadcast?.(`assistant:${runId}`, next);
    };

    try {
      recordEvent({ type: "started", text: "Assistant run started" });
      const skills = loadSkills(join(this.config.dataDir, "skills")).filter((skill) => skill.enabled !== false);
      const memory = readAgentMemoryContent({ dataDir: this.config.dataDir, agent: agentName });
      const journalTail = readJournalTail({
        dataDir: this.config.dataDir,
        agent: agentName,
        maxLines: settings.journal_tail_lines,
      });
      const history = this.recentMessages(threadId, [userMessageId, assistantMessageId]);
      const systemPrompt = this.buildSystemPrompt({ agentName, skills, memory, journalTail, history, input });
      const model = resolveModel(settings.assistant_model || settings.slack_model || "openai:gpt-5.5");
      const mcpServers = assistantMcpServers(this.config);
      const response = await this.runAgent(systemPrompt, {
        model,
        effort: settings.assistant_effort || settings.slack_effort || "high",
        db: this.db,
        dataDir: this.config.dataDir,
        skills,
        messages: [{ role: "user", content: input }],
        cwd: this.config.workspace,
        mcpServers,
        allowedTools: [
          ...WORKLAB_BUILTIN_TOOLS,
          ...Object.keys(mcpServers).flatMap((name) => [`mcp__${name}`, `mcp__${name}__*`]),
        ],
        disallowedTools: [],
        permissionMode: "bypassPermissions",
        maxTurns: 12,
        outputSchema: ASSISTANT_RESULT_JSON_SCHEMA,
        abortSignal: signal.signal,
        onEvent: recordEvent,
      });
      if (response.cancelled || signal.signal.aborted) {
        recordEvent({ type: "cancelled" });
        this.finishCancelled({ runId, assistantMessageId, message: "Assistant run cancelled", events });
        return null;
      }
      if (response.error) throw new Error(response.error);

      let result;
      try {
        result = parseAssistantResult(response.text);
      } catch (err) {
        result = fallbackAssistantResult(response.text, err);
        recordEvent({
          type: "runtime_warning",
          warning_kind: "assistant_result_parse",
          message: result.parse_error,
        });
      }

      this.applyResult({ agentName, runId, threadId, userMessageId, assistantMessageId, input, result });
      recordEvent({
        type: "final",
        text: result.reply_text,
        result,
        usage: response.usage || {},
        durationMs: response.durationMs,
        numTurns: response.numTurns,
        model: response.model,
        effort: response.effort,
      });
      this.db.prepare(`
        UPDATE assistant_runs
        SET status = 'succeeded', ended_at = ?, input_tokens = ?, output_tokens = ?,
            cache_read_tokens = ?, cache_creation_tokens = ?, cost_usd = ?,
            duration_ms = ?, num_turns = ?, summary = ?, final_json = ?
        WHERE id = ?
      `).run(
        Date.now(),
        usageInt(response.usage, "input_tokens"),
        usageInt(response.usage, "output_tokens"),
        usageInt(response.usage, "cache_read_input_tokens") ?? usageInt(response.usage, "cache_read_tokens"),
        usageInt(response.usage, "cache_creation_input_tokens") ?? usageInt(response.usage, "cache_creation_tokens"),
        usageNumber(response.usage, "cost_usd"),
        response.durationMs || null,
        response.numTurns || null,
        result.summary,
        JSON.stringify(result),
        runId,
      );
      this.db.prepare("UPDATE assistant_agent_logs SET status = 'succeeded', events = ? WHERE assistant_run_id = ?")
        .run(JSON.stringify(events), runId);
      this.broker?.broadcast?.(`assistant:${runId}`, { type: "done" });
      this.broker?.broadcast?.("global", { type: "assistant_run_ended", thread_id: threadId, run_id: runId, status: "succeeded" });
      return result;
    } catch (err) {
      const message = err?.message || String(err);
      if (signal.signal.aborted) {
        recordEvent({ type: "cancelled" });
        this.finishCancelled({ runId, assistantMessageId, message: "Assistant run cancelled", events });
      } else {
        recordEvent({ type: "error", message });
        this.db.prepare("UPDATE assistant_runs SET status = 'failed', ended_at = ?, error_text = ? WHERE id = ?")
          .run(Date.now(), message, runId);
        this.db.prepare("UPDATE assistant_messages SET status = 'failed', body = ?, updated_at = ? WHERE id = ?")
          .run(`Assistant failed: ${message}`, Date.now(), assistantMessageId);
        this.db.prepare("UPDATE assistant_agent_logs SET status = 'failed', events = ? WHERE assistant_run_id = ?")
          .run(JSON.stringify(events), runId);
        this.broker?.broadcast?.(`assistant:${runId}`, { type: "done" });
        this.broker?.broadcast?.("global", { type: "assistant_run_ended", thread_id: threadId, run_id: runId, status: "failed" });
      }
      return null;
    } finally {
      signal.cleanup();
    }
  }

  applyResult({ agentName, runId, threadId, userMessageId, assistantMessageId, input, result }) {
    const now = Date.now();
    const bullets = result.journal_bullets.length ? result.journal_bullets : [result.summary];
    for (const bullet of bullets) {
      appendJournalEntry({
        dataDir: this.config.dataDir,
        agent: agentName,
        runId,
        taskId: `assistant:${threadId}`,
        taskTitle: "Worklab assistant chat",
        bullet,
      });
    }
    if (result.action_items.length) {
      appendJournalEntry({
        dataDir: this.config.dataDir,
        agent: agentName,
        runId,
        taskId: `assistant:${threadId}`,
        taskTitle: "Worklab assistant chat",
        bullet: `Action items: ${result.action_items.join("; ")}`,
      });
    }
    appendJournalSummary({ dataDir: this.config.dataDir, agent: agentName, runId, text: result.summary });
    appendMemoryFacts({ dataDir: this.config.dataDir, agent: agentName, runId, facts: result.memory_facts });

    this.db.prepare("UPDATE assistant_messages SET body = ?, status = 'complete', updated_at = ? WHERE id = ?")
      .run(result.reply_text, now, assistantMessageId);
    this.db.prepare("UPDATE assistant_messages SET updated_at = ? WHERE id = ?").run(now, userMessageId);
    this.db.prepare("UPDATE assistant_threads SET updated_at = ? WHERE id = ?").run(now, threadId);
  }

  finishCancelled({ runId, assistantMessageId, message, events }) {
    const now = Date.now();
    this.db.prepare("UPDATE assistant_runs SET status = 'cancelled', ended_at = ?, error_text = ? WHERE id = ?")
      .run(now, message, runId);
    this.db.prepare("UPDATE assistant_messages SET status = 'cancelled', body = ?, updated_at = ? WHERE id = ?")
      .run(message, now, assistantMessageId);
    this.db.prepare("UPDATE assistant_agent_logs SET status = 'cancelled', events = ? WHERE assistant_run_id = ?")
      .run(JSON.stringify(events || []), runId);
    this.broker?.broadcast?.(`assistant:${runId}`, { type: "done" });
    this.broker?.broadcast?.("global", { type: "assistant_run_ended", run_id: runId, status: "cancelled" });
  }

  cancelRun(runId) {
    const row = this.db.prepare("SELECT * FROM assistant_runs WHERE id = ?").get(runId);
    if (!row) return { ok: false, status: 404, code: "not_found", message: "assistant run not found" };
    if (row.status !== "running") {
      return { ok: false, status: 409, code: "run_not_active", message: "assistant run is not running" };
    }
    const active = this.active.get(runId);
    if (active?.cancel) active.cancel();
    else this.finishCancelled({
      runId,
      assistantMessageId: row.assistant_message_id,
      message: "Assistant run cancelled",
      events: this.getRunEvents(runId),
    });
    return { ok: true, run: this.getRun(runId) };
  }

  waitIdle() {
    return Promise.all([...this.active.values()].map((entry) => entry.promise));
  }
}

export function createWorklabAssistantService(options) {
  return new WorklabAssistantService(options);
}
