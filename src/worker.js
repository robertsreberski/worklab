import { parseArgs } from "node:util";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { createLiveInputQueue, loadConfig, normalizeLiveInputBody, openDb } from "./core/index.js";
import { renderToolSurfaceMarkdown } from "./mcp/agent/tools/index.js";
import { configureToolRuntime } from "@mono-agent/agent-runtime/agent/tools/shared/runtime-context.js";
import { WORKLAB_RUNTIME_BRAND } from "./core/runtime-brand.js";

const WORKLAB_TOOL_SURFACE_MARKDOWN = renderToolSurfaceMarkdown(null);

import { runConsolidate } from "./worker/consolidate-runner.js";
import { runAutomation } from "./worker/automation-runner.js";
import { runTask } from "./worker/task-runner.js";
import { runReview } from "./worker/review-runner.js";
import { runLeadCycle } from "./worker/lead-cycle-runner.js";
import { emitFinalResult } from "./worker/result-emitter.js";
import { createApprovalChannel } from "./worker/approval-channel.js";
import { createAcpInteractionChannel } from "./worker/acp-interaction-channel.js";

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

const liveInput = createLiveInputQueue();
const approvalChannel = createApprovalChannel({ emit });
const acpInteractionChannel = createAcpInteractionChannel({ emit });

// R5: graceful drain protocol. The coordinator sends `{type:"worklab_drain"}`
// on shutdown so the worker can finish the in-flight tool call instead of
// being SIGKILL'd mid-edit. We expose the request via the abort controller so
// in-flight provider streams unwind cleanly, and emit a `drained` event on
// stdout so the coordinator can persist a resume snapshot tagged
// `resume_kind: "drained"`.
function createControlReaderState({ ac, emit, acpInteractionChannel }) {
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
      acpInteractionChannel.cancelAllPending("coordinator_shutdown");
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
    if (message?.type === "approval_decision") {
      approvalChannel.acceptDecision(message);
      return;
    }
    if (message?.type === "acp_interaction_response") {
      acpInteractionChannel.acceptResponse(message);
      return;
    }
    if (message?.type === "acp_interaction_cancel") {
      acpInteractionChannel.cancel(message.interaction_id || message.interactionId, {
        deliveryId: message.delivery_id || message.deliveryId || null,
        reason: "client_cancelled",
      });
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

  configureToolRuntime({
    workspace: config.workspace,
    repoRoot: config.repoRoot || process.env.WORKLAB_REPO_ROOT || null,
    runId,
    toolArtifactDir: config.dataDir,
    ripgrepPath: process.env.WORKLAB_RIPGREP_PATH || null,
    qaOutputDir: process.env.WORKLAB_QA_OUTPUT_DIR || null,
    runtimeBrand: WORKLAB_RUNTIME_BRAND,
  });

  emit({ type: "started", runId, ts: Date.now() });

  const db = openDb(join(config.dataDir, "worklab.db"));

  const ac = new AbortController();
  const abortRun = () => {
    acpInteractionChannel.cancelAllPending("run_aborted");
    ac.abort();
  };
  process.on("SIGTERM", abortRun);
  process.on("SIGINT", abortRun);

  const controlState = createControlReaderState({ ac, emit, acpInteractionChannel });
  startControlReader({ controlState });

  const ctx = {
    db,
    config,
    ac,
    emit,
    liveInput,
    approvalChannel,
    acpInteractionChannel,
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
      approvalChannel.denyAllPending("coordinator_shutdown");
      acpInteractionChannel.cancelAllPending("coordinator_shutdown");
      emit({ type: "cancelled", initiator: "coordinator_shutdown", drained: true });
      process.exit(0);
    }
  }
  approvalChannel.denyAllPending("run_terminated");
  acpInteractionChannel.cancelAllPending("run_terminated");

  const exitCode = emitFinalResult(ctx, result);
  process.exit(exitCode);
}

main();
