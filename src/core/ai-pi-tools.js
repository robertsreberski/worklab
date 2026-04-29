import { Type } from "@mariozechner/pi-ai";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  bashToolImpl,
  editToolImpl,
  globToolImpl,
  grepToolImpl,
  readToolImpl,
  webFetchToolImpl,
  webSearchToolImpl,
  writeToolImpl,
} from "./ai-tool-helpers.js";
import {
  createFileEditToolResultEvent,
  createFileEditToolUseEvent,
  fileChangeSummary,
  readFileChangeSnapshot,
  statsForCompletedChange,
} from "./file-change-stats.js";
import { formatSkillBodyWithPathNote } from "./skills.js";

function textResult(text, details = {}) {
  return {
    content: [{ type: "text", text: String(text ?? "") }],
    details,
  };
}

function objectSchema(properties, required = []) {
  return { type: "object", properties, required, additionalProperties: false };
}

function stripFrontmatter(content) {
  const m = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? content.slice(m[0].length).trim() : content.trim();
}

function isErrorText(value) {
  return /^Error:|^Exit code \d+:/i.test(String(value || "").trim());
}

function absolutizePath(value, cwd) {
  if (!value || typeof value !== "string" || isAbsolute(value) || !cwd) return value;
  return resolve(cwd, value);
}

function withAbsolutePaths(name, params, cwd) {
  const next = { ...(params || {}) };
  if (["Read", "Write", "Edit"].includes(name)) next.file_path = absolutizePath(next.file_path, cwd);
  if (["Glob", "Grep"].includes(name)) next.path = absolutizePath(next.path, cwd);
  return next;
}

async function withWorkspaceEnv(cwd, fn) {
  if (!cwd) return fn();
  const previous = process.env.WORKLAB_WORKSPACE;
  process.env.WORKLAB_WORKSPACE = cwd;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.WORKLAB_WORKSPACE;
    else process.env.WORKLAB_WORKSPACE = previous;
  }
}

function toolText(result) {
  if (typeof result === "string") return result;
  if (result == null) return "";
  try { return JSON.stringify(result); } catch { return String(result); }
}

function fileEditPayload(change, { status, before, after, error } = {}) {
  const lineStats = statsForCompletedChange(change, before, after);
  const completedChange = lineStats ? { ...change, line_stats: lineStats } : change;
  const summary = fileChangeSummary([completedChange]);
  return {
    changes: [completedChange],
    status,
    ...(summary ? { summary } : {}),
    ...(error ? { error } : {}),
  };
}

function createBuiltinTool(name, label, description, parameters, execute, { cwd, onEvent } = {}) {
  return {
    name,
    label,
    description,
    parameters,
    executionMode: name === "Write" || name === "Edit" || name === "Bash" ? "sequential" : undefined,
    async execute(toolCallId, params, signal) {
      if (signal?.aborted) throw new Error("tool execution aborted");
      const normalized = withAbsolutePaths(name, params, cwd);
      const isFileEdit = name === "Write" || name === "Edit";
      let editState = null;
      if (isFileEdit && normalized.file_path) {
        const before = readFileChangeSnapshot(normalized.file_path);
        editState = {
          path: normalized.file_path,
          before,
          change: {
            path: normalized.file_path,
            kind: name === "Write" && before && !before.exists ? "add" : "update",
          },
        };
        onEvent?.(createFileEditToolUseEvent(`file_edit:${toolCallId}`, {
          changes: [editState.change],
          status: "in_progress",
        }));
      }

      const raw = await withWorkspaceEnv(cwd, () => execute(normalized));
      const text = toolText(raw);
      if (isFileEdit && editState) {
        const failed = isErrorText(text);
        const after = readFileChangeSnapshot(editState.path);
        onEvent?.(createFileEditToolResultEvent(
          `file_edit:${toolCallId}`,
          fileEditPayload(editState.change, {
            status: failed ? "failed" : "completed",
            before: editState.before,
            after,
            error: failed ? text : null,
          }),
          { isError: failed },
        ));
      }
      if (isErrorText(text)) throw new Error(text);
      return textResult(text, { tool: name, params: normalized });
    },
  };
}

function readSkillTool(skillNames = [], dataDir) {
  const safe = skillNames.filter((name) => /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name));
  if (!safe.length || !dataDir) return null;
  return {
    name: "read_skill",
    label: "Read Skill",
    description: "Load the full instructions for a named Worklab skill.",
    parameters: objectSchema({ name: { type: "string", enum: safe } }, ["name"]),
    async execute(_toolCallId, { name }) {
      const path = resolve(dataDir, "skills", name, "SKILL.md");
      const root = resolve(dataDir, "skills");
      if (!path.startsWith(root + "/")) throw new Error(`invalid skill path: ${name}`);
      if (!existsSync(path)) throw new Error(`SKILL.md not found for ${name}`);
      return textResult(formatSkillBodyWithPathNote({
        body: stripFrontmatter(readFileSync(path, "utf8")),
        assetsPath: resolve(root, name),
        skillsRoot: root,
      }), { skill: name, path });
    },
  };
}

export function createStructuredOutputTool(outputSchema, onStructuredOutput) {
  if (!outputSchema) return null;
  return {
    name: "StructuredOutput",
    label: "Structured Output",
    description: "Submit the final structured result object. Call this once when the response is complete.",
    parameters: Type.Unsafe(outputSchema),
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      onStructuredOutput?.(params);
      return {
        content: [{ type: "text", text: "Structured output received." }],
        details: params,
        terminate: true,
      };
    },
  };
}

export function getPiBuiltinTools(allowedTools, { skillNames = [], dataDir, cwd, onEvent } = {}) {
  const all = {
    Read: createBuiltinTool("Read", "Read", "Read a local file with line numbers.", objectSchema({
      file_path: { type: "string" },
      offset: { type: "integer" },
      limit: { type: "integer" },
    }, ["file_path"]), readToolImpl, { cwd, onEvent }),
    Write: createBuiltinTool("Write", "Write", "Write content to a local file.", objectSchema({
      file_path: { type: "string" },
      content: { type: "string" },
    }, ["file_path", "content"]), writeToolImpl, { cwd, onEvent }),
    Edit: createBuiltinTool("Edit", "Edit", "Replace an exact string in a local file.", objectSchema({
      file_path: { type: "string" },
      old_string: { type: "string" },
      new_string: { type: "string" },
      replace_all: { type: "boolean" },
    }, ["file_path", "old_string", "new_string"]), editToolImpl, { cwd, onEvent }),
    Glob: createBuiltinTool("Glob", "Glob", "Find files matching a pattern.", objectSchema({
      pattern: { type: "string" },
      path: { type: "string" },
    }, ["pattern"]), globToolImpl, { cwd, onEvent }),
    Grep: createBuiltinTool("Grep", "Grep", "Search file contents with grep.", objectSchema({
      pattern: { type: "string" },
      path: { type: "string" },
      glob: { type: "string" },
      context: { type: "integer" },
      case_insensitive: { type: "boolean" },
    }, ["pattern"]), grepToolImpl, { cwd, onEvent }),
    Bash: createBuiltinTool("Bash", "Bash", "Execute a shell command in the Worklab workspace.", objectSchema({
      command: { type: "string" },
      timeout: { type: "integer" },
    }, ["command"]), bashToolImpl, { cwd, onEvent }),
    WebFetch: createBuiltinTool("WebFetch", "Web Fetch", "Fetch a URL and return text.", objectSchema({
      url: { type: "string" },
      headers: { type: "object", additionalProperties: { type: "string" } },
    }, ["url"]), webFetchToolImpl, { cwd, onEvent }),
    WebSearch: createBuiltinTool("WebSearch", "Web Search", "Search the web and return result summaries.", objectSchema({
      query: { type: "string" },
      limit: { type: "integer" },
    }, ["query"]), webSearchToolImpl, { cwd, onEvent }),
  };
  const names = Array.isArray(allowedTools) ? allowedTools : Object.keys(all);
  const tools = names.map((name) => all[name]).filter(Boolean);
  const skillTool = readSkillTool(skillNames, dataDir);
  if (skillTool) tools.push(skillTool);
  return tools;
}

async function connectMcpClient(name, cfg) {
  const client = new McpClient({ name: `worklab/${name}`, version: "0.1.0" }, { capabilities: {} });
  let transport;
  if (cfg.type === "http") {
    transport = new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers || {} } });
  } else if (cfg.type === "sse") {
    transport = new SSEClientTransport(new URL(cfg.url), {
      eventSourceInit: { headers: cfg.headers || {} },
      requestInit: { headers: cfg.headers || {} },
    });
  } else {
    transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args || [],
      env: { ...process.env, ...(cfg.env || {}) },
    });
  }
  await client.connect(transport);
  return { name, client, transport };
}

function coerceMcpContent(out) {
  if (Array.isArray(out?.content) && out.content.length) {
    return out.content.map((part) => {
      if (part.type === "text") return { type: "text", text: part.text || "" };
      if (part.type === "image") return {
        type: "image",
        data: part.data,
        mimeType: part.mimeType || part.mime_type || "image/png",
      };
      return { type: "text", text: JSON.stringify(part) };
    });
  }
  return [{ type: "text", text: JSON.stringify(out || {}) }];
}

function mcpToolName(serverName, toolName, reservedNames) {
  if (!reservedNames.has(toolName)) return toolName;
  return `mcp__${serverName}__${toolName}`;
}

export async function initPiMcpTools(mcpConfig, reservedNames = new Set()) {
  const clients = [];
  const tools = [];
  const entries = Object.entries(mcpConfig || {});
  const settled = await Promise.allSettled(entries.map(([name, cfg]) => connectMcpClient(name, cfg)));
  const warnings = [];
  const seen = new Set(reservedNames);

  for (const [index, result] of settled.entries()) {
    const serverName = entries[index]?.[0];
    if (result.status !== "fulfilled") {
      warnings.push({
        type: "runtime_warning",
        warning_kind: "mcp_init_failed",
        server: serverName,
        message: result.reason?.message || String(result.reason),
      });
      continue;
    }

    const connected = result.value;
    clients.push(connected);
    let listed;
    try {
      listed = await connected.client.listTools();
    } catch (err) {
      warnings.push({
        type: "runtime_warning",
        warning_kind: "mcp_list_tools_failed",
        server: serverName,
        message: err?.message || String(err),
      });
      continue;
    }

    for (const sourceTool of listed.tools || []) {
      const name = mcpToolName(serverName, sourceTool.name, seen);
      if (seen.has(name)) continue;
      seen.add(name);
      tools.push({
        name,
        label: sourceTool.title || sourceTool.name,
        description: sourceTool.description || `${serverName}:${sourceTool.name}`,
        parameters: sourceTool.inputSchema || sourceTool.input_schema || objectSchema({}),
        async execute(_toolCallId, params, signal) {
          if (signal?.aborted) throw new Error("tool execution aborted");
          const out = await connected.client.callTool({ name: sourceTool.name, arguments: params || {} });
          return {
            content: coerceMcpContent(out),
            details: { server: serverName, tool: sourceTool.name, raw: out },
          };
        },
      });
    }
  }
  return { clients, tools, warnings };
}

export async function closePiMcpClients(clients) {
  for (const { client, transport } of clients || []) {
    try { await client.close?.(); } catch { /* best-effort */ }
    try { await transport.close?.(); } catch { /* best-effort */ }
  }
}
