import { estimateFirstTurnInput } from "../core/first-turn-estimate.js";
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
  const { db, config, ac, emit, liveInput, approvalChannel, agentName, runId, taskId } = ctx;

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
  } = input;
  const model = resolveModel(agent.model);
  const sdkEvents = createSdkEventCoalescer((event) => emit({ type: "sdk_event", event }));
  // HITL approval wiring — see Phase 3 of the agent-runtime usage uplift.
  // When the agent opts in (`require_human_approval = 1`), we install
  // onToolApprovalRequest + per-tool risk tiers + the agent's timeout
  // override. Without the opt-in, the package falls back to its built-in
  // defaults (no callback ⇒ medium auto-approves, high fails closed).
  const approvalEnabled = !!agent.require_human_approval && approvalChannel;
  let toolRiskTiers = {};
  if (approvalEnabled) {
    try { toolRiskTiers = JSON.parse(agent.tool_risk_tiers_json || "{}") || {}; }
    catch { toolRiskTiers = {}; }
  }
  const approvalTimeoutMs = Number.isFinite(Number(agent.approval_timeout_ms))
    ? Number(agent.approval_timeout_ms)
    : undefined;
  // Per-agent fallback chain — Phase 4 of the agent-runtime usage uplift.
  // Parses the agents.fallback_chain_json column. When non-empty, generateResponse
  // routes through createRouterRuntime so retryable provider failures cascade
  // through the configured list. Malformed JSON falls back to the empty array
  // (no router) so a typo in the config doesn't break the run.
  let fallbackChain = [];
  if (agent.fallback_chain_json) {
    try {
      const parsed = JSON.parse(agent.fallback_chain_json);
      if (Array.isArray(parsed)) fallbackChain = parsed.filter(Boolean);
    } catch { fallbackChain = []; }
  }
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
      permissionMode: "bypassPermissions",
      maxTurns: maxTurnsForModel(model, 30),
      outputSchema,
      runArtifactDir: input.qaOutputDir,
      abortSignal: ac.signal,
      liveInput,
      onEvent: sdkEvents.emit,
      ...(approvalEnabled
        ? {
          onToolApprovalRequest: (payload) => approvalChannel.request(payload),
          toolRiskTiers,
          ...(approvalTimeoutMs !== undefined ? { approvalTimeoutMs } : {}),
        }
        : {}),
      ...(fallbackChain.length > 0 ? { fallbackChain } : {}),
    });
    const terminal = terminalProviderResult(kind, result);
    return terminal ? { terminal, input } : { result, input };
  } catch (err) {
    return { terminal: { kind, error: err.message || String(err) }, input };
  } finally {
    sdkEvents.flush();
  }
}
