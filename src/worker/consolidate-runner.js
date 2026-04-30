import {
  buildConsolidationSystemPrompt,
  generateResponse,
  readAgentMemoryContent,
  readFullJournal,
  resolveModel,
  writeMemory,
} from "../core/index.js";
import { getAgentByName } from "../core/db/queries/agents.js";
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
    if (result.cancelled) return { kind: "consolidate", cancelled: true };
    if (result.error) {
      return { kind: "consolidate", error: result.error, failureKind: result.failureKind };
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
      runtimeWarnings: result.runtimeWarnings,
      memoryWritten: { agent: agentName, path },
    };
  } catch (err) {
    return { kind: "consolidate", error: err.message || String(err) };
  }
}
