import { effectiveTeamForTask } from "./teams.js";
import { getTeamRosterAgentNames } from "./db/queries/teams.js";
import { getAgentByName } from "./db/queries/agents.js";
import { resolveModel } from "./ai.js";

const VALID_SUBAGENT_MODES = new Set(["advisory", "workspace"]);
const ADVISORY_TOOLS = new Set(["Read", "Glob", "Grep", "WebFetch", "WebSearch"]);

function normalizeSubagentMode(value) {
  return VALID_SUBAGENT_MODES.has(value) ? value : null;
}

function providerToolName(provider) {
  if (provider === "pi") return "AskAgent";
  if (provider === "claude") return "Task";
  if (provider === "codex") return "spawnAgent";
  return "native subagent";
}

function displayName(agent) {
  return agent?.display_name || agent?.displayName || agent?.name || "agent";
}

function helperSystemPrompt({ parentAgent, teammate, mode }) {
  return [
    `You are ${displayName(teammate)} (\`${teammate.name}\`), a Worklab teammate helping ${displayName(parentAgent)} (\`${parentAgent.name}\`).`,
    "Answer only the bounded request you were given. Be concrete, cite files or evidence when relevant, and keep the response compact.",
    "Do not emit `worklab_result` JSON, create Worklab subtasks, or claim you completed parent-run finalization. The parent agent owns the final Worklab result.",
    mode === "advisory"
      ? "You are in advisory mode: inspect, reason, and report. Do not modify workspace files or run mutating shell commands."
      : "You are in workspace mode: you may use the configured workspace tools when needed, but keep changes narrowly scoped to the request.",
    "",
    teammate.instructions || "",
  ].filter(Boolean).join("\n");
}

function formatPrompt(nativeSubagents) {
  const toolName = nativeSubagents.toolName;
  const modeLine = nativeSubagents.mode === "workspace"
    ? "Mode: workspace helpers may use their configured workspace capabilities."
    : "Mode: advisory helpers may inspect and report, but should not modify files.";
  const rows = nativeSubagents.teammates.map((agent) => {
    const label = agent.displayName && agent.displayName !== agent.name
      ? `\`${agent.name}\` (${agent.displayName})`
      : `\`${agent.name}\``;
    const runtime = [agent.modelRef, agent.effort].filter(Boolean).join(" / ");
    const description = agent.description ? ` - ${agent.description}` : "";
    return `- ${label}${runtime ? `: ${runtime}` : ""}${description}`;
  });
  return [
    `Native teammate subagents are available through the runtime's native \`${toolName}\` surface.`,
    modeLine,
    `Use at most ${nativeSubagents.maxChildrenPerRound} helper request(s) in this run, with at most ${nativeSubagents.maxParallelChildren} running in parallel.`,
    "Use native subagents for bounded sidecar help: research, focused code reading, independent verification, or a small implementation slice that is not the immediate blocker for your next step.",
    "Incorporate helper findings into your own final answer. Use Worklab `decision: \"delegate\"` only when you need durable child tasks.",
    "",
    ...rows,
  ].join("\n");
}

function shapeTeammateCapabilities({ capabilities, mode }) {
  if (mode === "workspace") {
    return {
      skills: capabilities.skills || [],
      skillDirs: capabilities.skillDirs || [],
      mcpServers: capabilities.mcpServers || {},
      allowedTools: capabilities.allowedTools || [],
      disallowedTools: capabilities.disallowedTools || [],
      toolPolicy: capabilities.toolPolicy || null,
      capabilityRestrictions: capabilities.capabilityRestrictions || null,
    };
  }
  const allowedTools = (capabilities.allowedTools || []).filter((tool) => ADVISORY_TOOLS.has(tool));
  return {
    skills: capabilities.skills || [],
    skillDirs: capabilities.skillDirs || [],
    mcpServers: {},
    allowedTools,
    disallowedTools: [],
    toolPolicy: { ...(capabilities.toolPolicy || {}), bashReadOnly: true },
    capabilityRestrictions: capabilities.capabilityRestrictions || null,
  };
}

export function buildNativeSubagentContext({
  db,
  config,
  task,
  parentAgent,
  agentName,
  runId,
  mode,
  settings = {},
  loadCapabilities,
} = {}) {
  const subagentMode = normalizeSubagentMode(parentAgent?.subagent_mode || "advisory");
  if (!subagentMode) return null;
  const teamId = effectiveTeamForTask(db, task);
  if (!teamId) return null;

  let parentResolved;
  try {
    parentResolved = resolveModel(parentAgent.model);
  } catch {
    return null;
  }
  const provider = parentResolved.sdk;
  if (!["claude", "codex", "pi"].includes(provider)) return null;

  const maxChildrenPerRound = Math.max(1, Number(settings.delegation_max_children_per_round) || 5);
  const maxParallelChildren = Math.max(1, Number(settings.delegation_max_parallel_children) || 3);
  const rosterNames = getTeamRosterAgentNames(db, teamId);
  const skipped = [];
  const teammates = [];

  for (const name of rosterNames) {
    if (!name || name === agentName) continue;
    const teammate = getAgentByName(db, name);
    if (!teammate || teammate.enabled === 0) {
      skipped.push({ name, reason: "disabled_or_missing" });
      continue;
    }
    let resolved;
    try {
      resolved = resolveModel(teammate.model);
    } catch (err) {
      skipped.push({ name, reason: "invalid_model", message: err.message });
      continue;
    }
    if (resolved.sdk !== provider) {
      skipped.push({ name, reason: "different_runtime", sdk: resolved.sdk });
      continue;
    }
    if (typeof loadCapabilities !== "function") {
      skipped.push({ name, reason: "capabilities_unavailable" });
      continue;
    }
    const rawCapabilities = loadCapabilities({
      config,
      agent: teammate,
      agentName: name,
      runId,
      mode,
      env: {
        WORKLAB_TASK_ID: task?.id || "",
        WORKLAB_TASK_TITLE: task?.title || "",
      },
    });
    const shaped = shapeTeammateCapabilities({ capabilities: rawCapabilities, mode: subagentMode });
    teammates.push({
      name,
      displayName: displayName(teammate),
      description: teammate.description || "",
      sdk: resolved.sdk,
      modelRef: resolved.reference,
      model: resolved,
      effort: teammate.effort || "medium",
      instructions: teammate.instructions || "",
      mode: subagentMode,
      helperSystemPrompt: helperSystemPrompt({ parentAgent, teammate, mode: subagentMode }),
      ...shaped,
    });
  }

  if (!teammates.length) return null;
  const context = {
    enabled: true,
    provider,
    mode: subagentMode,
    teamId,
    toolName: providerToolName(provider),
    maxChildrenPerRound,
    maxParallelChildren,
    teammates,
    skipped,
  };
  return {
    ...context,
    promptMarkdown: formatPrompt(context),
  };
}
