import { estimateFirstTurnInput } from "@worklab-ai/agent-runtime/agent/compaction.js";
import {
  buildTaskRunInput,
  generateResponse,
  resolveModel,
} from "../core/index.js";
import { createSdkEventCoalescer } from "./event-coalescer.js";
import { maxTurnsForModel } from "./util.js";

function terminalProviderResult(kind, result) {
  if (result.cancelled) return { kind, cancelled: true, providerSessionId: result.providerSessionId || null };
  if (!result.error) return null;
  return {
    kind,
    error: result.error,
    failureKind: result.failureKind,
    errorDetails: result.errorDetails || null,
    diagnostics: result.diagnostics || null,
    providerSessionId: result.providerSessionId || null,
    runtimeWarnings: result.runtimeWarnings,
  };
}

export async function runTaskAgentTurn(ctx, {
  kind,
  mode,
  outputSchema,
  priorRunId = null,
} = {}) {
  const { db, config, ac, emit, liveInput, agentName, runId, taskId } = ctx;

  let input;
  try {
    input = buildTaskRunInput({
      config,
      db,
      taskId,
      agentName,
      runId,
      mode,
      ...(priorRunId ? { priorRunId } : {}),
      worklabToolSurfaceMarkdown: ctx.worklabToolSurfaceMarkdown,
    });
  } catch (err) {
    return { terminal: { kind, error: err.message || String(err) } };
  }

  const {
    agent,
    skills,
    skillDirs,
    mcpServers,
    allowedTools,
    disallowedTools,
    toolPolicy,
    systemPrompt,
    messages,
    nativeSubagents,
  } = input;
  const model = resolveModel(agent.model);
  const sdkEvents = createSdkEventCoalescer((event) => emit({ type: "sdk_event", event }));
  const firstTurn = estimateFirstTurnInput({ systemPrompt, messages });
  emit({
    type: "prompt_built",
    diagnostics: {
      first_turn_input_tokens: firstTurn.inputTokens,
      first_turn_overhead_tokens: firstTurn.overheadTokens,
      first_turn_input_chars: firstTurn.inputChars,
      first_turn_overhead_chars: firstTurn.overheadChars,
    },
  });

  try {
    const result = await generateResponse(systemPrompt, {
      model,
      effort: agent.effort || "medium",
      executionMode: agent.execution_mode || "sdk",
      contextWindow: agent.context_window || "default",
      fastMode: agent.fast_mode !== undefined ? !!agent.fast_mode : true,
      db,
      dataDir: config.dataDir,
      skills,
      skillDirs,
      messages,
      cwd: config.workspace,
      mcpServers,
      allowedTools,
      disallowedTools,
      ...(toolPolicy ? { toolPolicy } : {}),
      nativeSubagents,
      permissionMode: "bypassPermissions",
      maxTurns: maxTurnsForModel(model, 30),
      outputSchema,
      runArtifactDir: input.qaOutputDir,
      abortSignal: ac.signal,
      liveInput,
      onEvent: sdkEvents.emit,
    });
    const terminal = terminalProviderResult(kind, result);
    return terminal ? { terminal, input } : { result, input };
  } catch (err) {
    return { terminal: { kind, error: err.message || String(err) }, input };
  } finally {
    sdkEvents.flush();
  }
}
