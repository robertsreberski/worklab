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
import { emitFinalResult } from "./worker/result-emitter.js";

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
    worklabToolSurfaceMarkdown: WORKLAB_TOOL_SURFACE_MARKDOWN,
  };

  let result;
  if (mode === "consolidate") {
    result = await runConsolidate(ctx);
  } else if (mode === "automation") {
    result = await runAutomation(ctx);
  } else if (mode === "plan" || mode === "execute") {
    result = await runTask(ctx);
  } else if (mode === "review") {
    result = await runReview(ctx);
  }

  const exitCode = emitFinalResult(ctx, result);
  process.exit(exitCode);
}

main();
