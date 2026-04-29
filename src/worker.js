import { parseArgs } from "node:util";
import { openDb } from "./core/db.js";
import { loadConfig } from "./core/config.js";
import { readFullJournal, writeMemory } from "./core/journal.js";
import { readAgentMemoryContent, readAgentMemoryContext } from "./core/memory.js";
import { buildConsolidationSystemPrompt, buildAutomationSystemPrompt } from "./core/context.js";
import { resolveModel, generateResponse } from "./core/ai.js";
import { parseVerdict } from "./core/review.js";
import { kbListPinned } from "./core/kb.js";
import { normalizeWorklabResult, parseWorklabResultFromText, synthesizeWorklabResult, validateWorklabResultSemantics } from "./core/worklab-result.js";
import { readSettings } from "./core/settings.js";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createLiveInputQueue, normalizeLiveInputBody } from "./core/live-input.js";
import { buildTaskRunInput, loadAgentCapabilities } from "./core/run-input.js";

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

const liveInput = createLiveInputQueue();

function startControlReader() {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      emit({ type: "runtime_warning", warning_kind: "live_input_parse", message: "Ignored malformed live input message." });
      return;
    }
    if (message?.type !== "live_user_message") return;
    const normalized = normalizeLiveInputBody(message.body);
    if (!normalized.ok) {
      emit({ type: "runtime_warning", warning_kind: "live_input_invalid", message: normalized.error });
      return;
    }
    liveInput.push({
      id: message.id || null,
      body: normalized.body,
      createdAt: message.created_at || Date.now(),
      authorType: message.author_type || "human",
    });
  });
  rl.on("close", () => liveInput.close());
}

function validateRuntimeResult(result) {
  const validated = validateWorklabResultSemantics(result);
  if (validated.ok) return { result, error: null, fatal: false };
  return { result, error: validated.error, fatal: true };
}

function resultFromTextOrFallback(text, fallback) {
  const parsed = parseWorklabResultFromText(text, fallback);
  if (parsed.ok) return validateRuntimeResult(parsed.result);
  if (!String(text || "").trim()) {
    return { result: null, error: "missing final output", fatal: true };
  }
  return { result: synthesizeWorklabResult({ ...fallback, details: text || "" }), error: parsed.error };
}

function resultFromResponseOrFallback(response, fallback) {
  if (response?.worklabResult) {
    const normalized = normalizeWorklabResult(response.worklabResult, fallback);
    if (normalized.ok) {
      return {
        ...validateRuntimeResult(normalized.result),
        source: response.structuredResultSource || "structured",
      };
    }
    return { result: null, error: normalized.error, fatal: true, source: response.structuredResultSource || "structured" };
  }
  return resultFromTextOrFallback(response?.text || "", fallback);
}

function reviewResultFromText(text) {
  const parsed = parseWorklabResultFromText(text, { stage: "review" });
  if (parsed.ok) {
    const validated = validateRuntimeResult(parsed.result);
    return {
      ...validated,
      verdict: parsed.result.decision === "approve" ? "APPROVE" : parsed.result.decision === "reject" ? "REJECT" : null,
      notes: parsed.result.details || parsed.result.summary || "",
    };
  }

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

function reviewResultFromResponse(response) {
  if (response?.worklabResult) {
    const normalized = normalizeWorklabResult(response.worklabResult, { stage: "review" });
    if (normalized.ok) {
      const result = normalized.result;
      return {
        ...validateRuntimeResult(result),
        verdict: result.decision === "approve" ? "APPROVE" : result.decision === "reject" ? "REJECT" : null,
        notes: result.details || result.summary || "",
        source: response.structuredResultSource || "structured",
      };
    }
    return { result: null, verdict: null, notes: "", error: normalized.error, fatal: true, source: response.structuredResultSource || "structured" };
  }
  return reviewResultFromText(response?.text || "");
}

function maxTurnsForModel(model, fallback) {
  if (["claude", "claude-code", "codex"].includes(model?.sdk)) return undefined;
  return fallback;
}

function emitRuntimeWarnings(response) {
  const warnings = Array.isArray(response?.runtimeWarnings) ? response.runtimeWarnings : [];
  for (const warning of warnings) {
    emit({
      type: "runtime_warning",
      warning_kind: warning?.warning_kind || warning?.warningKind || "runtime",
      message: warning?.message || String(warning || "runtime warning"),
      ts: Date.now(),
    });
  }
}

function loadAutomationSetup({ config, db, automationId, agentName, runId }) {
  const automation = db.prepare("SELECT * FROM automations WHERE id = ?").get(automationId);
  if (!automation) { emit({ type: "error", message: `automation ${automationId} not found` }); process.exit(1); }
  const agent = db.prepare("SELECT * FROM agents WHERE name = ?").get(agentName);
  if (!agent) { emit({ type: "error", message: `agent ${agentName} not found` }); process.exit(1); }
  const settings = readSettings(db);

  const { memory, journalTail } = readAgentMemoryContext({
    dataDir: config.dataDir,
    agent: agentName,
    maxJournalLines: settings.journal_tail_lines,
  });
  const { skills, mcpServers, allowedTools, disallowedTools } = loadAgentCapabilities({
    config,
    agent,
    agentName,
    runId,
    env: {
      WORKLAB_AUTOMATION_ID: automationId,
      WORKLAB_AUTOMATION_TITLE: automation.title,
    },
  });

  const pinnedKb = kbListPinned({ dataDir: config.dataDir, limit: settings.kb_pinned_limit });

  return { automation, agent, skills, memory, journalTail, mcpServers, allowedTools, disallowedTools, pinnedKb };
}

async function main() {
  startControlReader();

  const { values } = parseArgs({
    options: {
      task: { type: "string" },
      automation: { type: "string" },
      mode: { type: "string" },
      agent: { type: "string" },
    },
  });
  const { task: taskId, automation: automationId, mode, agent: agentName } = values;
  const runId = process.env.WORKLAB_RUN_ID;
  const config = loadConfig();

  if (!mode || !agentName || !runId || (!["consolidate", "automation"].includes(mode) && !taskId) || (mode === "automation" && !automationId)) {
    emit({ type: "error", message: "missing required args/env" });
    process.exit(1);
  }
  if (mode !== "plan" && mode !== "execute" && mode !== "review" && mode !== "consolidate" && mode !== "automation") {
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
    const memory = readAgentMemoryContent({ dataDir: config.dataDir, agent: agentName });
    const journal = readFullJournal({ dataDir: config.dataDir, agent: agentName });
    if (!journal.trim()) {
      emit({ type: "error", message: `agent ${agentName} has no journal entries to consolidate` });
      process.exit(1);
    }
    const systemPrompt = buildConsolidationSystemPrompt({ agent, memory, journal });
    const model = resolveModel(agent.model);
    try {
      const result = await generateResponse(systemPrompt, {
        model,
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
        maxTurns: maxTurnsForModel(model, 10),
        abortSignal: ac.signal,
        onEvent: (event) => emit({ type: "sdk_event", event }),
      });
      if (result.cancelled) {
        emit({ type: "cancelled" });
        process.exit(130);
      }
      if (result.error) {
        emit({ type: "error", message: result.error, failureKind: result.failureKind });
        process.exit(1);
      }
      emitRuntimeWarnings(result);
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

  if (mode === "automation") {
    const setup = loadAutomationSetup({ config, db, automationId, agentName, runId });
    const { automation, agent, skills, memory, journalTail, mcpServers, allowedTools, disallowedTools, pinnedKb } = setup;
    const systemPrompt = buildAutomationSystemPrompt({ agent, automation, skills, memory, journalTail, pinnedKb });
    const model = resolveModel(agent.model);
    try {
      const result = await generateResponse(systemPrompt, {
        model,
        effort: agent.effort || "medium",
        db,
        dataDir: config.dataDir,
        skills,
        messages: [{ role: "user", content: `Run automation "${automation.title}".` }],
        cwd: config.workspace,
        mcpServers,
        allowedTools,
        disallowedTools,
        permissionMode: "bypassPermissions",
        maxTurns: maxTurnsForModel(model, 30),
        abortSignal: ac.signal,
        onEvent: (event) => emit({ type: "sdk_event", event }),
      });
      if (result.cancelled) {
        emit({ type: "cancelled" });
        process.exit(130);
      }
      if (result.error) {
        emit({ type: "error", message: result.error, failureKind: result.failureKind });
        process.exit(1);
      }
      emitRuntimeWarnings(result);
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

  function loadTaskRunInputOrExit(options) {
    try {
      return buildTaskRunInput(options);
    } catch (err) {
      emit({ type: "error", message: err.message || String(err) });
      process.exit(1);
    }
  }

  // ── Plan / execute modes ────────────────────────────────────────────────────
  if (mode === "plan" || mode === "execute") {
    const runInput = loadTaskRunInputOrExit({ config, db, taskId, agentName, runId, mode });
    const {
      task,
      agent,
      skills,
      mcpServers,
      allowedTools,
      disallowedTools,
      systemPrompt,
      messages,
      promptDiagnostics,
    } = runInput;
    if (promptDiagnostics) emit({ type: "prompt_built", diagnostics: promptDiagnostics });
    const model = resolveModel(agent.model);

    try {
      const result = await generateResponse(systemPrompt, {
        model,
        effort: agent.effort || "medium",
        db,
        dataDir: config.dataDir,
        skills,
        messages,
        cwd: config.workspace,
        mcpServers,
        allowedTools,
        disallowedTools,
        permissionMode: "bypassPermissions",
        maxTurns: maxTurnsForModel(model, 30),
        abortSignal: ac.signal,
        liveInput,
        onEvent: (event) => emit({ type: "sdk_event", event }),
      });
      if (result.cancelled) {
        emit({ type: "cancelled" });
        process.exit(130);
      }
      if (result.error) {
        emit({ type: "error", message: result.error, failureKind: result.failureKind });
        process.exit(1);
      }
      emitRuntimeWarnings(result);
      const parsedResult = resultFromResponseOrFallback(result, {
        stage: task.stage || mode,
        decision: "advance",
        summary: result.text ? String(result.text).trim().slice(0, 500) : "Run completed",
      });
      if (parsedResult.error) {
        emit({
          type: "runtime_warning",
          warning_kind: parsedResult.fatal ? "worklab_result_validation" : "unstructured_result_fallback",
          message: parsedResult.error,
        });
      }
      if (parsedResult.fatal || !parsedResult.result) {
        emit({ type: "worklab_result_error", message: parsedResult.error || "Invalid worklab_result" });
        process.exit(1);
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
    const reviewInput = loadTaskRunInputOrExit({
      config,
      db,
      taskId,
      agentName,
      runId,
      mode,
      priorRunId: process.env.WORKLAB_PRIOR_RUN_ID,
    });
    const {
      agent,
      skills,
      mcpServers,
      allowedTools,
      disallowedTools,
      systemPrompt,
      messages,
      promptDiagnostics,
    } = reviewInput;
    if (promptDiagnostics) emit({ type: "prompt_built", diagnostics: promptDiagnostics });
    const model = resolveModel(agent.model);

    try {
      const result = await generateResponse(systemPrompt, {
        model,
        effort: agent.effort || "medium",
        db,
        dataDir: config.dataDir,
        skills,
        messages,
        cwd: config.workspace,
        mcpServers,
        allowedTools,
        disallowedTools,
        permissionMode: "bypassPermissions",
        maxTurns: maxTurnsForModel(model, 30),
        abortSignal: ac.signal,
        liveInput,
        onEvent: (event) => emit({ type: "sdk_event", event }),
      });
      if (result.cancelled) {
        emit({ type: "cancelled" });
        process.exit(130);
      }
      if (result.error) {
        emit({ type: "error", message: result.error, failureKind: result.failureKind });
        process.exit(1);
      }
      emitRuntimeWarnings(result);
      const parsedReview = reviewResultFromResponse(result);
      if (parsedReview.error) {
        emit({
          type: "runtime_warning",
          warning_kind: parsedReview.fatal ? "worklab_result_validation" : "review_result_parse",
          message: parsedReview.error,
        });
      }
      if (parsedReview.fatal || !parsedReview.result) {
        emit({ type: "worklab_result_error", message: parsedReview.error || "Reviewer did not return a valid worklab_result or verdict" });
        process.exit(1);
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
