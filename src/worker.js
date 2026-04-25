import { parseArgs } from "node:util";
import { openDb } from "./core/db.js";
import { loadConfig } from "./core/config.js";
import { loadSkills } from "./core/skills.js";
import { loadMcpConfig, getBuiltinMcpServers, pickMcpServers } from "./core/mcp-config.js";
import { readJournalTail, readFullJournal, writeMemory, agentMemoryPath } from "./core/journal.js";
import { buildPlanSystemPrompt, buildExecuteSystemPrompt, buildReviewSystemPrompt, buildConsolidationSystemPrompt } from "./core/context.js";
import { resolveModel, generateResponse } from "./core/ai.js";
import { parseVerdict } from "./core/review.js";
import { extractExecutionFromEvents } from "./core/review-exec.js";
import { kbListPinned } from "./core/kb.js";
import { parseWorklabResultFromText, synthesizeWorklabResult } from "./core/worklab-result.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function resultFromTextOrFallback(text, fallback) {
  const parsed = parseWorklabResultFromText(text, fallback);
  if (parsed.ok) return { result: parsed.result, error: null };
  return { result: synthesizeWorklabResult({ ...fallback, details: text || "" }), error: parsed.error };
}

function reviewResultFromText(text) {
  const parsed = parseWorklabResultFromText(text, { stage: "review" });
  if (parsed.ok) return { result: parsed.result, verdict: parsed.result.decision === "approve" ? "APPROVE" : parsed.result.decision === "reject" ? "REJECT" : null, notes: parsed.result.details || parsed.result.summary || "", error: null };

  const { verdict, notes } = parseVerdict(text);
  if (verdict === "APPROVE") {
    return {
      result: synthesizeWorklabResult({ stage: "review", decision: "approve", summary: notes || "Approved", details: text || "" }),
      verdict,
      notes,
      error: parsed.error,
    };
  }
  if (verdict === "REJECT") {
    return {
      result: synthesizeWorklabResult({ stage: "review", decision: "reject", summary: notes || "Rejected", details: text || "" }),
      verdict,
      notes,
      error: parsed.error,
    };
  }
  return { result: null, verdict: null, notes: "", error: parsed.error };
}

/**
 * Load the shared setup required by both execute and review modes:
 * agent row, task row, comments, skills, memory, journal tail, and MCP servers.
 *
 * Returns { task, agent, commentRows, skills, memory, journalTail, mcpServers, allowedTools }
 * or calls emit({ type:"error" }) + process.exit(1) on any missing required data.
 */
function loadCommonSetup({ config, db, taskId, agentName, runId }) {
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
  if (!task) { emit({ type: "error", message: `task ${taskId} not found` }); process.exit(1); }
  const agent = db.prepare("SELECT * FROM agents WHERE name = ?").get(agentName);
  if (!agent) { emit({ type: "error", message: `agent ${agentName} not found` }); process.exit(1); }

  const commentRows = db.prepare("SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at").all(taskId);

  const skillsAll = loadSkills(join(config.dataDir, "skills"));
  const skillAllowlist = JSON.parse(agent.skills_allowlist || "[]");
  const skills = skillAllowlist.length === 0 ? skillsAll : skillsAll.filter(s => skillAllowlist.includes(s.name));

  const memoryPath = agentMemoryPath(config.dataDir, agentName);
  const memory = existsSync(memoryPath) ? readFileSync(memoryPath, "utf8") : "";
  const journalTail = readJournalTail({ dataDir: config.dataDir, agent: agentName, maxLines: 80 });

  const userMcpServers = loadMcpConfig(config.dataDir);
  const allMcpServers = { ...getBuiltinMcpServers(config.repoRoot), ...userMcpServers };
  const mcpAllowlist = JSON.parse(agent.mcp_allowlist || "[]");
  const mcpServers = pickMcpServers(allMcpServers, mcpAllowlist.length === 0 ? [] : ["worklab", ...mcpAllowlist]);

  // Inject worklab-mcp env so the built-in server knows which agent/run it's serving
  if (mcpServers.worklab) {
    mcpServers.worklab = {
      ...mcpServers.worklab,
      env: {
        ...(mcpServers.worklab.env || {}),
        WORKLAB_DATA_DIR: config.dataDir,
        WORKLAB_AGENT_NAME: agentName,
        WORKLAB_RUN_ID: runId,
        WORKLAB_TASK_ID: taskId,
        WORKLAB_TASK_TITLE: task.title,
      },
    };
  }

  const builtinAllowlist = JSON.parse(agent.builtin_allowlist || "[]");
  const allowedTools = builtinAllowlist.length === 0
    ? ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebFetch", "WebSearch"]
    : builtinAllowlist;

  const kbPinnedLimitRaw = db.prepare("SELECT value FROM settings WHERE key = 'kb_pinned_limit'").get()?.value ?? 10;
  const kbPinnedLimit = Number(kbPinnedLimitRaw) || 10;
  const pinnedKb = kbListPinned({ dataDir: config.dataDir, limit: kbPinnedLimit });

  return { task, agent, commentRows, skills, memory, journalTail, mcpServers, allowedTools, pinnedKb };
}

function loadPriorRunSummaries(db, taskId, currentRunId, limit = 4) {
  const runs = db.prepare(
    `SELECT * FROM task_runs
      WHERE task_id = ? AND id != ?
      ORDER BY started_at DESC, rowid DESC
      LIMIT ?`,
  ).all(taskId, currentRunId, limit);

  return runs.map((run) => {
    const logRow = db.prepare("SELECT * FROM agent_logs WHERE task_run_id = ?").get(run.id);
    const priorEvents = logRow ? JSON.parse(logRow.events || "[]") : [];
    const execution = extractExecutionFromEvents(priorEvents, run);
    return {
      mode: run.mode,
      status: run.status,
      agentName: run.agent_name ?? "unknown",
      startedAt: run.started_at ?? null,
      endedAt: run.ended_at ?? null,
      errorText: run.error_text ?? null,
      finalText: execution.finalText,
      numTurns: execution.numTurns,
      durationMs: execution.durationMs,
    };
  });
}

async function main() {
  const { values } = parseArgs({
    options: {
      task: { type: "string" },
      mode: { type: "string" },
      agent: { type: "string" },
    },
  });
  const { task: taskId, mode, agent: agentName } = values;
  const runId = process.env.WORKLAB_RUN_ID;
  const config = loadConfig();

  if (!mode || !agentName || !runId || (mode !== "consolidate" && !taskId)) {
    emit({ type: "error", message: "missing required args/env" });
    process.exit(1);
  }
  if (mode !== "plan" && mode !== "execute" && mode !== "review" && mode !== "consolidate") {
    emit({ type: "error", message: `mode ${mode} not implemented` });
    process.exit(1);
  }

  emit({ type: "started", runId, ts: Date.now() });

  const db = openDb(join(config.dataDir, "worklab.db"));

  const ac = new AbortController();
  process.on("SIGTERM", () => { ac.abort(); });
  process.on("SIGINT", () => { ac.abort(); });

  if (mode === "consolidate") {
    const agent = db.prepare("SELECT * FROM agents WHERE name = ?").get(agentName);
    if (!agent) { emit({ type: "error", message: `agent ${agentName} not found` }); process.exit(1); }
    const memoryPath = agentMemoryPath(config.dataDir, agentName);
    const memory = existsSync(memoryPath) ? readFileSync(memoryPath, "utf8") : "";
    const journal = readFullJournal({ dataDir: config.dataDir, agent: agentName });
    if (!journal.trim()) {
      emit({ type: "error", message: `agent ${agentName} has no journal entries to consolidate` });
      process.exit(1);
    }
    const systemPrompt = buildConsolidationSystemPrompt({ agent, memory, journal });
    try {
      const result = await generateResponse(systemPrompt, {
        model: resolveModel(agent.model),
        effort: agent.effort || "medium",
        db,
        dataDir: config.dataDir,
        skills: [],
        messages: [{ role: "user", content: "Consolidate this agent's journal into MEMORY.md." }],
        cwd: config.workspace,
        mcpServers: {},
        allowedTools: [],
        disallowedTools: ["journal_append", "journal_summary"],
        permissionMode: "bypassPermissions",
        maxTurns: 10,
        abortSignal: ac.signal,
        onEvent: (event) => emit({ type: "sdk_event", event }),
      });
      if (result.cancelled) {
        emit({ type: "cancelled" });
        process.exit(130);
      }
      if (result.error) {
        emit({ type: "error", message: result.error });
        process.exit(1);
      }
      const path = writeMemory({ dataDir: config.dataDir, agent: agentName, content: result.text });
      emit({ type: "memory_written", agent: agentName, path });
      emit({
        type: "final",
        text: result.text,
        usage: result.usage,
        durationMs: result.durationMs,
        numTurns: result.numTurns,
        model: result.model,
        effort: result.effort,
      });
      process.exit(0);
    } catch (err) {
      emit({ type: "error", message: err.message || String(err) });
      process.exit(1);
    }
  }

  const setup = loadCommonSetup({ config, db, taskId, agentName, runId });
  const { task, agent, commentRows, skills, memory, journalTail, mcpServers, allowedTools, pinnedKb } = setup;

  // ── Plan / execute modes ────────────────────────────────────────────────────
  if (mode === "plan" || mode === "execute") {
    const priorRuns = loadPriorRunSummaries(db, taskId, runId);
    const promptInput = { agent, task, skills, memory, journalTail, comments: commentRows, pinnedKb, priorRuns };
    const systemPrompt = mode === "plan"
      ? buildPlanSystemPrompt(promptInput)
      : buildExecuteSystemPrompt(promptInput);

    try {
      const result = await generateResponse(systemPrompt, {
        model: resolveModel(agent.model),
        effort: agent.effort || "medium",
        db,
        dataDir: config.dataDir,
        skills,
        messages: [{ role: "user", content: `${mode === "plan" ? "Plan" : "Work on"} task "${task.title}".` }],
        cwd: config.workspace,
        mcpServers,
        allowedTools,
        disallowedTools: [],
        permissionMode: "bypassPermissions",
        maxTurns: 30,
        abortSignal: ac.signal,
        onEvent: (event) => emit({ type: "sdk_event", event }),
      });
      if (result.cancelled) {
        emit({ type: "cancelled" });
        process.exit(130);
      }
      if (result.error) {
        emit({ type: "error", message: result.error });
        process.exit(1);
      }
      const parsedResult = resultFromTextOrFallback(result.text, {
        stage: task.stage || mode,
        decision: "advance",
        summary: result.text ? String(result.text).trim().slice(0, 500) : "Run completed",
      });
      if (parsedResult.error) {
        emit({ type: "runtime_warning", warning_kind: "unstructured_result_fallback", message: parsedResult.error });
      }
      emit({
        type: "final",
        text: result.text,
        worklab_result: parsedResult.result,
        usage: result.usage,
        durationMs: result.durationMs,
        numTurns: result.numTurns,
        model: result.model,
        effort: result.effort,
      });
      process.exit(0);
    } catch (err) {
      emit({ type: "error", message: err.message || String(err) });
      process.exit(1);
    }
  }

  // ── Review mode ─────────────────────────────────────────────────────────────
  // Review mode has the same tool allowlist as execute. We document — but do not enforce — that
  // reviewers should not call kb_delete. Enforcement via per-tool permissions is Phase 4+.
  if (mode === "review") {
    const priorRunId = process.env.WORKLAB_PRIOR_RUN_ID;
    if (!priorRunId) {
      emit({ type: "error", message: "WORKLAB_PRIOR_RUN_ID is required for review mode" });
      process.exit(1);
    }

    const priorRun = db.prepare("SELECT * FROM task_runs WHERE id = ?").get(priorRunId);
    if (!priorRun) {
      emit({ type: "error", message: `prior run ${priorRunId} not found` });
      process.exit(1);
    }

    const priorLog = db.prepare("SELECT * FROM agent_logs WHERE task_run_id = ?").get(priorRun.id);
    const priorEvents = priorLog ? JSON.parse(priorLog.events) : [];

    const execution = extractExecutionFromEvents(priorEvents, priorRun);

    const systemPrompt = buildReviewSystemPrompt({
      agent, task, skills, memory, journalTail, comments: commentRows, pinnedKb, execution,
    });

    try {
      const result = await generateResponse(systemPrompt, {
        model: resolveModel(agent.model),
        effort: agent.effort || "medium",
        db,
        dataDir: config.dataDir,
        skills,
        messages: [{ role: "user", content: `Review task "${task.title}". Respond with your verdict.` }],
        cwd: config.workspace,
        mcpServers,
        allowedTools,
        disallowedTools: [],
        permissionMode: "bypassPermissions",
        maxTurns: 30,
        abortSignal: ac.signal,
        onEvent: (event) => emit({ type: "sdk_event", event }),
      });
      if (result.cancelled) {
        emit({ type: "cancelled" });
        process.exit(130);
      }
      if (result.error) {
        emit({ type: "error", message: result.error });
        process.exit(1);
      }
      const parsedReview = reviewResultFromText(result.text);
      if (parsedReview.error) {
        emit({ type: "runtime_warning", warning_kind: "review_result_parse", message: parsedReview.error });
      }
      if (!parsedReview.result) {
        emit({ type: "worklab_result_error", message: "Reviewer did not return a valid worklab_result or verdict" });
      }
      emit({
        type: "final",
        text: result.text,
        worklab_result: parsedReview.result,
        usage: result.usage,
        durationMs: result.durationMs,
        numTurns: result.numTurns,
        model: result.model,
        effort: result.effort,
      });

      // Always emit verdict (null is valid); process exit now reflects runtime
      // success only, while coordinator handles invalid semantic output.
      emit({ type: "verdict", verdict: parsedReview.verdict, notes: parsedReview.notes });
      process.exit(0);
    } catch (err) {
      emit({ type: "error", message: err.message || String(err) });
      process.exit(1);
    }
  }
}

main();
