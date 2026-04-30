import {
  generateResponse,
  kbListPinned,
  loadAgentCapabilities,
  readAgentMemoryContext,
  readSettings,
  resolveModel,
} from "../core/index.js";
import { buildAutomationSystemPrompt } from "../agent/prompt/system-prompt.js";
import { getAgentByName } from "../core/db/queries/agents.js";
import { getAutomationById } from "../core/db/queries/automations.js";
import { createSdkEventCoalescer } from "./event-coalescer.js";
import { maxTurnsForModel } from "./util.js";

function loadAutomationSetup({ config, db, automationId, agentName, runId }) {
  const automation = getAutomationById(db, automationId);
  if (!automation) return { error: `automation ${automationId} not found` };
  const agent = getAgentByName(db, agentName);
  if (!agent) return { error: `agent ${agentName} not found` };
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

export async function runAutomation(ctx) {
  const { db, config, ac, emit, agentName, runId, automationId } = ctx;

  const setup = loadAutomationSetup({ config, db, automationId, agentName, runId });
  if (setup.error) return { kind: "automation", error: setup.error };
  const { automation, agent, skills, memory, journalTail, mcpServers, allowedTools, disallowedTools, pinnedKb } = setup;
  const systemPrompt = buildAutomationSystemPrompt({ agent, automation, skills, memory, journalTail, pinnedKb });
  const model = resolveModel(agent.model);
  const sdkEvents = createSdkEventCoalescer((event) => emit({ type: "sdk_event", event }));
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
      onEvent: sdkEvents.emit,
    });
    if (result.cancelled) return { kind: "automation", cancelled: true };
    if (result.error) {
      return { kind: "automation", error: result.error, failureKind: result.failureKind };
    }
    return {
      kind: "automation",
      text: result.text,
      usage: result.usage,
      durationMs: result.durationMs,
      numTurns: result.numTurns,
      model: result.model,
      effort: result.effort,
      runtimeWarnings: result.runtimeWarnings,
    };
  } catch (err) {
    return { kind: "automation", error: err.message || String(err) };
  } finally {
    sdkEvents.flush();
  }
}
