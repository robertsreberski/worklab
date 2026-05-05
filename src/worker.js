import { parseArgs } from "node:util";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { createLiveInputQueue, loadConfig, normalizeLiveInputBody, openDb } from "./core/index.js";
import { renderToolSurfaceMarkdown } from "./mcp/agent/tools/index.js";

const WORKLAB_TOOL_SURFACE_MARKDOWN = renderToolSurfaceMarkdown(null);

import { runConsolidate } from "./worker/consolidate-runner.js";
import { runAutomation } from "./worker/automation-runner.js";
import { runTask } from "./worker/task-runner.js";
import { runReview } from "./worker/review-runner.js";
import { runLeadCycle } from "./worker/lead-cycle-runner.js";
import { emitFinalResult } from "./worker/result-emitter.js";

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

const liveInput = createLiveInputQueue();

// R5: graceful drain protocol. The coordinator sends `{type:"worklab_drain"}`
// on shutdown so the worker can finish the in-flight tool call instead of
// being SIGKILL'd mid-edit. We expose the request via the abort controller so
// in-flight provider streams unwind cleanly, and emit a `drained` event on
// stdout so the coordinator can persist a resume snapshot tagged
// `resume_kind: "drained"`.
function createControlReaderState({ ac, emit }) {
  let drainRequested = false;
  return {
    isDraining() { return drainRequested; },
    handleDrain(message) {
      if (drainRequested) return;
      drainRequested = true;
      const reason = typeof message?.reason === "string" ? message.reason : "coordinator_shutdown";
      const deadlineAt = Number.isFinite(Number(message?.deadline_at)) ? Number(message.deadline_at) : null;
      emit({
        type: "drained",
        reason,
        ...(deadlineAt ? { deadline_at: deadlineAt } : {}),
        ts: Date.now(),
      });
      try { ac.abort(); } catch { /* already aborted */ }
    },
  };
}

function startControlReader({ controlState }) {
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
    if (message?.type === "worklab_drain") {
      controlState.handleDrain(message);
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

async function main() {

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
  const runKind = process.env.WORKLAB_RUN_KIND || "task";
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

  const controlState = createControlReaderState({ ac, emit });
  startControlReader({ controlState });

  const ctx = {
    db,
    config,
    ac,
    emit,
    liveInput,
    agentName,
    runId,
    taskId,
    automationId,
    mode,
    runKind,
    worklabToolSurfaceMarkdown: WORKLAB_TOOL_SURFACE_MARKDOWN,
  };

  let result;
  if (runKind === "lead_cycle") {
    result = await runLeadCycle(ctx);
  } else if (mode === "consolidate") {
    result = await runConsolidate(ctx);
  } else if (mode === "automation") {
    result = await runAutomation(ctx);
  } else if (mode === "plan" || mode === "execute") {
    result = await runTask(ctx);
  } else if (mode === "review") {
    result = await runReview(ctx);
  }

  // R5: when drain was requested, mark the final stdout event as a coordinator
  // shutdown so the coordinator can tag the resume snapshot accordingly. We
  // exit cleanly with code 0; the spawn-worker side keys off `drainRequested`
  // (set when it issued the drain) to classify the run as `cancelled_shutdown`.
  if (controlState.isDraining()) {
    if (!result || result.cancelled || result.error) {
      emit({ type: "cancelled", initiator: "coordinator_shutdown", drained: true });
      process.exit(0);
    }
  }

  const exitCode = emitFinalResult(ctx, result);
  process.exit(exitCode);
}

main();
