import { Type } from "@earendil-works/pi-ai";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import {
  bashToolImpl,
  editToolImpl,
  globToolImpl,
  grepToolImpl,
  normalizeBashTimeoutMs,
  readToolImpl,
  webFetchToolImpl,
  webSearchToolImpl,
  writeToolImpl,
} from "./index.js";
import {
  createFileEditToolResultEvent,
  createFileEditToolUseEvent,
  fileChangeSummary,
  readFileChangeSnapshot,
  statsForCompletedChange,
} from "../../ai/file-change-stats.js";
import { formatSkillBodyWithPathNote } from "../prompt/skill-index.js";
import { MAX_TOOL_RESULT_BYTES, summarisePayload, wrapToolsWithBloatGuard } from "../tool-bloat.js";
import { wrapToolsWithApprovalGate } from "../approval.js";
import { readRuntimeBrand, readToolRuntime } from "./shared/runtime-context.js";

function textResult(text, details = {}) {
  return {
    content: [{ type: "text", text: String(text ?? "") }],
    details,
  };
}

const MCP_TEXT_RESULT_LIMIT = 12_000;
const MCP_RAW_DETAIL_LIMIT = 4_000;
const MCP_IMAGE_INLINE_MAX_BYTES = 250_000;
const DEFAULT_BASH_TIMEOUT_MS = 120_000;

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

function isInsidePath(root, target) {
  if (!root || !target) return false;
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

const PLAYWRIGHT_FILENAME_TOOLS = new Set([
  "browser_console_messages",
  "browser_snapshot",
  "browser_take_screenshot",
]);

function artifactFilename(filename, outputDir) {
  if (!filename || typeof filename !== "string" || isAbsolute(filename) || !outputDir) return filename;
  const base = resolve(outputDir);
  const requested = resolve(base, filename);
  const target = isInsidePath(base, requested) ? requested : resolve(base, basename(filename));
  mkdirSync(dirname(target), { recursive: true });
  return target;
}

export function normalizeMcpToolParams(_serverName, toolName, params, { qaOutputDir } = {}) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return params;
  if (!PLAYWRIGHT_FILENAME_TOOLS.has(toolName) || !params.filename || isAbsolute(String(params.filename))) return params;
  const dir = qaOutputDir ?? readToolRuntime().qaOutputDir;
  return {
    ...params,
    filename: artifactFilename(params.filename, dir),
  };
}

function normalizeWorkdir(value, cwd) {
  const base = resolve(cwd || readToolRuntime().workspace || process.cwd());
  const resolved = value ? resolve(absolutizePath(value, base)) : base;
  return isInsidePath(base, resolved) ? resolved : base;
}

function withAbsolutePaths(name, params, cwd) {
  const next = { ...(params || {}) };
  if (["Read", "Write", "Edit"].includes(name)) next.file_path = absolutizePath(next.file_path, cwd);
  if (["Glob", "Grep"].includes(name)) next.path = absolutizePath(next.path, cwd);
  if (["Read", "Write", "Edit", "Glob", "Grep", "Bash"].includes(name)) {
    next.workdir = normalizeWorkdir(next.workdir, cwd);
  }
  return next;
}

function toolText(result) {
  if (typeof result === "string") return result;
  if (result == null) return "";
  try { return JSON.stringify(result); } catch { return String(result); }
}

function base64Bytes(data) {
  const text = String(data || "");
  if (!text) return 0;
  const clean = text.includes(",") ? text.slice(text.indexOf(",") + 1) : text;
  return Math.floor(clean.length * 0.75);
}

function truncateMcpText(text, limit = MCP_TEXT_RESULT_LIMIT) {
  const value = String(text || "");
  if (value.length <= limit) return { text: value, truncated: false, originalLength: value.length };
  const marker = [
    "",
    `[truncated MCP tool result from ${value.length} to ${limit} characters]`,
    "Use a more specific Worklab MCP tool, filters, or a detail/get tool for the exact item you need.",
  ].join("\n");
  return {
    text: `${value.slice(0, Math.max(0, limit - marker.length))}${marker}`,
    truncated: true,
    originalLength: value.length,
  };
}

function compactRawMcpResult(out) {
  let text;
  try {
    text = JSON.stringify(out || {});
  } catch {
    text = String(out ?? "");
  }
  if (text.length <= MCP_RAW_DETAIL_LIMIT) return out;
  return {
    truncated: true,
    original_length: text.length,
    preview: `${text.slice(0, MCP_RAW_DETAIL_LIMIT)}\n[truncated raw MCP result]`,
  };
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

function limitedNumber(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), fallback);
}

function withToolLimits(name, params, limits = {}) {
  const next = { ...(params || {}) };
  if (["Read", "Glob", "Grep", "WebFetch"].includes(name)) {
    next.max_output_chars = limitedNumber(next.max_output_chars, limits.toolTextLimitChars || 16000);
  }
  if (name === "Glob") {
    next.limit = limitedNumber(next.limit ?? next.max_matches, limits.searchResultLimit || 100);
    delete next.max_matches;
  }
  if (name === "Grep") {
    next.head_limit = limitedNumber(next.head_limit ?? next.max_matches, limits.searchResultLimit || 100);
    next.output_mode = next.output_mode || "files_with_matches";
    delete next.max_matches;
  }
  if (name === "Bash") {
    next.max_output_chars = limitedNumber(next.max_output_chars, limits.bashOutputLimitChars || limits.toolTextLimitChars || 20000);
    next.timeout = normalizeBashTimeoutMs(next.timeout, limits.bashTimeoutMs || DEFAULT_BASH_TIMEOUT_MS);
  }
  return next;
}

export function normalizePiBuiltinToolParams(name, params, { cwd, toolLimits } = {}) {
  return withToolLimits(name, withAbsolutePaths(name, params, cwd), toolLimits);
}

function integerSchema() {
  return { type: "integer" };
}

function isReadOnlyShellCommand(command) {
  const text = String(command || "").trim();
  if (!text) return false;
  if (/[;&|`<>]|\$\(/.test(text)) return false;
  return [
    /^pwd(\s|$)/,
    /^ls(\s|$)/,
    /^find(\s|$)/,
    /^rg(\s|$)/,
    /^grep(\s|$)/,
    /^sed(\s|$)/,
    /^awk(\s|$)/,
    /^cat(\s|$)/,
    /^head(\s|$)/,
    /^tail(\s|$)/,
    /^wc(\s|$)/,
    /^git\s+(status|diff|log|show|branch|rev-parse|ls-files)(\s|$)/,
  ].some((pattern) => pattern.test(text));
}

function createBuiltinTool(name, label, description, parameters, execute, { cwd, onEvent, toolLimits, toolPolicy } = {}) {
  return {
    name,
    label,
    description,
    parameters,
    executionMode: name === "Write" || name === "Edit" || name === "Bash" ? "sequential" : undefined,
    async execute(toolCallId, params, signal) {
      if (signal?.aborted) throw new Error("tool execution aborted");
      const normalized = normalizePiBuiltinToolParams(name, params, { cwd, toolLimits });
      if (name === "Bash" && toolPolicy?.bashReadOnly && !isReadOnlyShellCommand(normalized.command)) {
        throw new Error("Error: Planning shell policy allows only read-only inspection commands.");
      }
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

      const raw = await execute(normalized, { signal });
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

export function getPiBuiltinTools(allowedTools, {
  skillNames = [],
  dataDir,
  cwd,
  onEvent,
  toolLimits,
  persistArtifact = null,
  onTruncate = null,
  toolPayloadMaxBytes = MAX_TOOL_RESULT_BYTES,
  toolPolicy = null,
  approvalManager = null,
  approvalModel = null,
} = {}) {
  const textLimitSchema = integerSchema();
  const bashLimitSchema = integerSchema();
  const bashTimeoutSchema = {
    type: "integer",
    description: "Timeout in milliseconds. Use 30000 for 30 seconds; small values like 30 are treated as seconds for compatibility.",
  };
  const all = {
    Read: createBuiltinTool("Read", "Read", "Read a local file with line numbers.", objectSchema({
      file_path: { type: "string" },
      offset: { type: "integer" },
      start_line: { type: "integer" },
      limit: { type: "integer" },
      max_output_chars: textLimitSchema,
    }, ["file_path"]), readToolImpl, { cwd, onEvent, toolLimits, toolPolicy }),
    Write: createBuiltinTool("Write", "Write", "Write content to a local file.", objectSchema({
      file_path: { type: "string" },
      content: { type: "string" },
    }, ["file_path", "content"]), writeToolImpl, { cwd, onEvent, toolLimits, toolPolicy }),
    Edit: createBuiltinTool("Edit", "Edit", "Replace an exact string in a local file.", objectSchema({
      file_path: { type: "string" },
      old_string: { type: "string" },
      new_string: { type: "string" },
      replace_all: { type: "boolean" },
    }, ["file_path", "old_string", "new_string"]), editToolImpl, { cwd, onEvent, toolLimits, toolPolicy }),
    Glob: createBuiltinTool("Glob", "Glob", "Find files matching a pattern.", objectSchema({
      pattern: { type: "string" },
      path: { type: "string" },
      limit: { type: "integer" },
      offset: { type: "integer" },
      max_matches: { type: "integer" },
      max_output_chars: textLimitSchema,
    }, ["pattern"]), globToolImpl, { cwd, onEvent, toolLimits, toolPolicy }),
    Grep: createBuiltinTool("Grep", "Grep", "Search file contents with ripgrep. Defaults to returning matching file paths; use output_mode='content' only for exact snippets.", objectSchema({
      pattern: { type: "string" },
      path: { type: "string" },
      glob: { type: "string" },
      type: { type: "string" },
      output_mode: { type: "string", enum: ["files_with_matches", "content", "count"] },
      context: { type: "integer" },
      case_insensitive: { type: "boolean" },
      multiline: { type: "boolean" },
      head_limit: { type: "integer" },
      offset: { type: "integer" },
      max_matches: { type: "integer" },
      max_output_chars: textLimitSchema,
    }, ["pattern"]), grepToolImpl, { cwd, onEvent, toolLimits, toolPolicy }),
    Bash: createBuiltinTool("Bash", "Bash", "Execute a shell command in the Worklab workspace.", objectSchema({
      command: { type: "string" },
      workdir: { type: "string" },
      description: { type: "string" },
      timeout: bashTimeoutSchema,
      max_output_chars: bashLimitSchema,
    }, ["command"]), bashToolImpl, { cwd, onEvent, toolLimits, toolPolicy }),
    WebFetch: createBuiltinTool("WebFetch", "Web Fetch", "Fetch a URL and return text.", objectSchema({
      url: { type: "string" },
      headers: { type: "object", additionalProperties: { type: "string" } },
      max_output_chars: textLimitSchema,
    }, ["url"]), webFetchToolImpl, { cwd, onEvent, toolLimits, toolPolicy }),
    WebSearch: createBuiltinTool("WebSearch", "Web Search", "Search the web and return result summaries.", objectSchema({
      query: { type: "string" },
      limit: { type: "integer" },
    }, ["query"]), webSearchToolImpl, { cwd, onEvent, toolPolicy }),
  };
  const names = Array.isArray(allowedTools) ? allowedTools : Object.keys(all);
  const tools = names.map((name) => all[name]).filter(Boolean);
  const skillTool = readSkillTool(skillNames, dataDir);
  if (skillTool) tools.push(skillTool);
  const gated = approvalManager
    ? wrapToolsWithApprovalGate(tools, approvalManager, { model: approvalModel })
    : tools;
  return wrapToolsWithBloatGuard(gated, {
    persistArtifact,
    maxBytes: toolPayloadMaxBytes,
    onTruncate,
  });
}

export function resolveMcpStdioCwd(cfg = {}, cwd = null) {
  const configured = cfg.cwd || null;
  if (configured && isAbsolute(configured)) return configured;
  if (configured) return resolve(cwd || process.cwd(), configured);
  return cwd || process.cwd();
}

async function connectMcpClient(name, cfg, { cwd } = {}) {
  const brand = readRuntimeBrand();
  const client = new McpClient(
    { name: `${brand.mcpClientName}/${name}`, version: brand.mcpClientVersion },
    { capabilities: {} },
  );
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
      cwd: resolveMcpStdioCwd(cfg, cwd),
      env: { ...process.env, ...(cfg.env || {}) },
    });
  }
  await client.connect(transport);
  return { name, client, transport };
}

export function coerceMcpContent(out, {
  textLimit = MCP_TEXT_RESULT_LIMIT,
  imageInlineMaxBytes = MCP_IMAGE_INLINE_MAX_BYTES,
  persistArtifact = null,
  toolName = "mcp",
  toolUseId = null,
  onTruncate = null,
} = {}) {
  if (Array.isArray(out?.content) && out.content.length) {
    return out.content.map((part) => {
      if (part.type === "text") return { type: "text", text: truncateMcpText(part.text || "", textLimit).text };
      if (part.type === "image") {
        const bytes = base64Bytes(part.data);
        if (bytes > imageInlineMaxBytes) {
          const summary = summarisePayload(toolName, [{
            type: "image",
            data: part.data,
            mimeType: part.mimeType || part.mime_type || "image/png",
          }], persistArtifact, { maxBytes: imageInlineMaxBytes, toolUseId });
          if (summary.truncated && typeof onTruncate === "function") {
            try {
              onTruncate({
                tool: toolName,
                tool_use_id: toolUseId,
                original_bytes: summary.originalBytes,
                max_bytes: imageInlineMaxBytes,
                saved_paths: summary.savedPaths,
              });
            } catch { /* best-effort */ }
          }
          return summary.rewrittenBlocks[0] || {
            type: "text",
            text: `[omitted MCP image result: ${bytes} bytes exceeds ${imageInlineMaxBytes} byte context budget]`,
          };
        }
        return {
          type: "image",
          data: part.data,
          mimeType: part.mimeType || part.mime_type || "image/png",
        };
      }
      return { type: "text", text: truncateMcpText(JSON.stringify(part), textLimit).text };
    });
  }
  return [{ type: "text", text: truncateMcpText(JSON.stringify(out || {}), textLimit).text }];
}

function mcpContentWasTruncated(out, { textLimit = MCP_TEXT_RESULT_LIMIT, imageInlineMaxBytes = MCP_IMAGE_INLINE_MAX_BYTES } = {}) {
  if (Array.isArray(out?.content) && out.content.length) {
    return out.content.some((part) => {
      if (part.type === "text") return truncateMcpText(part.text || "", textLimit).truncated;
      if (part.type === "image") return base64Bytes(part.data) > imageInlineMaxBytes;
      return truncateMcpText(JSON.stringify(part), textLimit).truncated;
    });
  }
  return truncateMcpText(JSON.stringify(out || {}), textLimit).truncated;
}

function mcpToolName(serverName, toolName, reservedNames) {
  if (!reservedNames.has(toolName)) return toolName;
  return `mcp__${serverName}__${toolName}`;
}

function withTimeout(promise, timeoutMs, signal, label) {
  if (signal?.aborted) return Promise.reject(new Error("tool execution aborted"));
  const ms = Number(timeoutMs) || 120000;
  let timeout;
  const timer = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label || "MCP tool"} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timer]).finally(() => clearTimeout(timeout));
}

export async function initPiMcpTools(mcpConfig, reservedNames = new Set(), {
  limits = {},
  cwd = null,
  persistArtifact = null,
  qaOutputDir = null,
  onTruncate = null,
  toolPayloadMaxBytes = MAX_TOOL_RESULT_BYTES,
} = {}) {
  const clients = [];
  const tools = [];
  const entries = Object.entries(mcpConfig || {});
  const settled = await Promise.allSettled(entries.map(([name, cfg]) => connectMcpClient(name, cfg, { cwd })));
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
        async execute(toolCallId, params, signal) {
          if (signal?.aborted) throw new Error("tool execution aborted");
          const textLimit = limits.mcpTextLimitChars || MCP_TEXT_RESULT_LIMIT;
          const imageInlineMaxBytes = limits.imageInlineMaxBytes ?? MCP_IMAGE_INLINE_MAX_BYTES;
          const normalizedParams = normalizeMcpToolParams(serverName, sourceTool.name, params || {}, { qaOutputDir });
          const out = await withTimeout(
            connected.client.callTool({ name: sourceTool.name, arguments: normalizedParams || {} }),
            limits.mcpCallTimeoutMs || 120000,
            signal,
            `${serverName}:${sourceTool.name}`,
          );
          const imageTruncations = [];
          return {
            content: coerceMcpContent(out, {
              textLimit,
              imageInlineMaxBytes,
              persistArtifact,
              toolName: name,
              toolUseId: toolCallId,
              onTruncate: (event) => {
                imageTruncations.push(event);
                onTruncate?.(event);
              },
            }),
            details: {
              server: serverName,
              tool: sourceTool.name,
              result_truncated: mcpContentWasTruncated(out, { textLimit, imageInlineMaxBytes }),
              raw: compactRawMcpResult(out),
              ...(imageTruncations.length ? {
                tool_payload_truncated: true,
                tool_payload_original_bytes: imageTruncations.reduce((sum, event) => sum + (Number(event.original_bytes) || 0), 0),
                tool_payload_saved_paths: imageTruncations.flatMap((event) => event.saved_paths || []),
              } : {}),
            },
          };
        },
      });
    }
  }
  return {
    clients,
    tools: wrapToolsWithBloatGuard(tools, {
      persistArtifact,
      maxBytes: toolPayloadMaxBytes,
      onTruncate,
    }),
    warnings,
  };
}

export async function closePiMcpClients(clients) {
  for (const { client, transport } of clients || []) {
    try { await client.close?.(); } catch { /* best-effort */ }
    try { await transport.close?.(); } catch { /* best-effort */ }
  }
}
