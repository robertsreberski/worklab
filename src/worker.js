import { parseArgs } from "node:util";
import { openDb } from "./core/db.js";
import { loadConfig } from "./core/config.js";
import { loadSkills } from "./core/skills.js";
import { loadMcpConfig, getBuiltinMcpServers, pickMcpServers } from "./core/mcp-config.js";
import { readJournalTail, agentMemoryPath } from "./core/journal.js";
import { buildExecuteSystemPrompt } from "./core/context.js";
import { resolveModel, generateResponse } from "./core/ai.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function main() {
  const { values } = parseArgs({
    options: {
      task: { type: "string" },
      mode: { type: "string" },
      agent: { type: "string" },
    },
  });
  const { task: taskId, mode, agent: agentName } = values;
  const runId = process.env.WORKLAB_RUN_ID;
  const config = loadConfig();

  if (!taskId || !mode || !agentName || !runId) {
    emit({ type: "error", message: "missing required args/env" });
    process.exit(1);
  }
  if (mode !== "execute") {
    emit({ type: "error", message: `mode ${mode} not implemented in phase 2` });
    process.exit(1);
  }

  emit({ type: "started", runId, ts: Date.now() });

  const db = openDb(join(config.dataDir, "worklab.db"));

  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
  if (!task) { emit({ type: "error", message: `task ${taskId} not found` }); process.exit(1); }
  const agent = db.prepare("SELECT * FROM agents WHERE name = ?").get(agentName);
  if (!agent) { emit({ type: "error", message: `agent ${agentName} not found` }); process.exit(1); }

  const commentRows = db.prepare("SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at").all(taskId);

  const skillsAll = loadSkills(join(config.dataDir, "skills"));
  const skillAllowlist = JSON.parse(agent.skills_allowlist || "[]");
  const skills = skillAllowlist.length === 0 ? skillsAll : skillsAll.filter(s => skillAllowlist.includes(s.name));

  const memoryPath = agentMemoryPath(config.dataDir, agentName);
  const memory = existsSync(memoryPath) ? readFileSync(memoryPath, "utf8") : "";
  const journalTail = readJournalTail({ dataDir: config.dataDir, agent: agentName, maxLines: 80 });

  const userMcpServers = loadMcpConfig(config.dataDir);
  const allMcpServers = { ...getBuiltinMcpServers(config.repoRoot), ...userMcpServers };
  const mcpAllowlist = JSON.parse(agent.mcp_allowlist || "[]");
  const mcpServers = pickMcpServers(allMcpServers, mcpAllowlist.length === 0 ? [] : ["worklab", ...mcpAllowlist]);

  // Inject worklab-mcp env so the built-in server knows which agent/run it's serving
  if (mcpServers.worklab) {
    mcpServers.worklab = {
      ...mcpServers.worklab,
      env: {
        ...(mcpServers.worklab.env || {}),
        WORKLAB_DATA_DIR: config.dataDir,
        WORKLAB_AGENT_NAME: agentName,
        WORKLAB_RUN_ID: runId,
        WORKLAB_TASK_ID: taskId,
        WORKLAB_TASK_TITLE: task.title,
      },
    };
  }

  const builtinAllowlist = JSON.parse(agent.builtin_allowlist || "[]");
  const allowedTools = builtinAllowlist.length === 0
    ? ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebFetch", "WebSearch"]
    : builtinAllowlist;

  const systemPrompt = buildExecuteSystemPrompt({
    agent, task, skills, memory, journalTail, comments: commentRows, pinnedKb: [],
  });

  const ac = new AbortController();
  process.on("SIGTERM", () => { ac.abort(); });
  process.on("SIGINT", () => { ac.abort(); });

  try {
    const result = await generateResponse(systemPrompt, {
      model: resolveModel(agent.model),
      effort: agent.effort || "medium",
      messages: [{ role: "user", content: `Work on task "${task.title}".` }],
      cwd: config.workspace,
      mcpServers,
      allowedTools,
      disallowedTools: [],
      permissionMode: "bypassPermissions",
      maxTurns: 30,
      abortSignal: ac.signal,
      onEvent: (event) => emit({ type: "sdk_event", event }),
    });
    if (result.cancelled) {
      emit({ type: "cancelled" });
      process.exit(130);
    }
    if (result.error) {
      emit({ type: "error", message: result.error });
      process.exit(1);
    }
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

main();
