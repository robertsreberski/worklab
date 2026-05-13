import {
  generateResponse,
  readAgentMemoryContent,
  readFullJournal,
  resolveModel,
  writeMemory,
} from "../core/index.js";
import { buildConsolidationSystemPrompt } from "../core/prompts/system-prompt.js";
import { estimateFirstTurnInput } from "@worklab/agent-runtime/agent/compaction.js";
import { getAgentByName } from "../core/db/queries/agents.js";
import { createSdkEventCoalescer } from "./event-coalescer.js";
import { maxTurnsForModel } from "./util.js";

export async function runConsolidate(ctx) {
  const { db, config, ac, emit, agentName } = ctx;

  const agent = getAgentByName(db, agentName);
  if (!agent) {
    return { kind: "consolidate", error: `agent ${agentName} not found` };
  }
  const memory = readAgentMemoryContent({ dataDir: config.dataDir, agent: agentName });
  const journal = readFullJournal({ dataDir: config.dataDir, agent: agentName });
  if (!journal.trim()) {
    return { kind: "consolidate", error: `agent ${agentName} has no journal entries to consolidate` };
  }

  const systemPrompt = buildConsolidationSystemPrompt({ agent, memory, journal });
  const model = resolveModel(agent.model);
  const sdkEvents = createSdkEventCoalescer((event) => emit({ type: "sdk_event", event }));
  const consolidateMessages = [{ role: "user", content: "Consolidate this agent's journal into MEMORY.md." }];
  const firstTurn = estimateFirstTurnInput({ systemPrompt, messages: consolidateMessages });
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
      skills: [],
      messages: consolidateMessages,
      cwd: config.workspace,
      mcpServers: {},
      allowedTools: [],
      disallowedTools: ["journal_append", "journal_summary"],
      permissionMode: "bypassPermissions",
      maxTurns: maxTurnsForModel(model, 10),
      abortSignal: ac.signal,
      onEvent: sdkEvents.emit,
    });
    if (result.cancelled) return { kind: "consolidate", cancelled: true, providerSessionId: result.providerSessionId || null };
    if (result.error) {
      return {
        kind: "consolidate",
        error: result.error,
        failureKind: result.failureKind,
        errorDetails: result.errorDetails || null,
        diagnostics: result.diagnostics || null,
        providerSessionId: result.providerSessionId || null,
      };
    }
    const path = writeMemory({ dataDir: config.dataDir, agent: agentName, content: result.text });
    return {
      kind: "consolidate",
      text: result.text,
      usage: result.usage,
      durationMs: result.durationMs,
      numTurns: result.numTurns,
      model: result.model,
      effort: result.effort,
      providerSessionId: result.providerSessionId || null,
      runtimeWarnings: result.runtimeWarnings,
      memoryWritten: { agent: agentName, path },
    };
  } catch (err) {
    return { kind: "consolidate", error: err.message || String(err) };
  } finally {
    sdkEvents.flush();
  }
}
