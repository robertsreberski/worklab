import { streamText, stepCountIs, tool as makeTool } from "ai";
import { z } from "zod";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { estimateCost } from "./cost.js";
import { defaultOllamaNumCtx, resolveVercelModel } from "./providers.js";
import { getVercelTools } from "./ai-vercel-tools.js";

function jsonSchemaToZod(schema) {
  if (!schema || schema.type !== "object") return z.object({}).passthrough();
  const required = new Set(schema.required || []);
  const shape = {};
  for (const [key, prop] of Object.entries(schema.properties || {})) {
    let type = z.any();
    if (prop?.type === "string") type = z.string();
    else if (prop?.type === "number" || prop?.type === "integer") type = z.number();
    else if (prop?.type === "boolean") type = z.boolean();
    else if (prop?.type === "array") type = z.array(z.any());
    else if (prop?.type === "object") type = z.record(z.string(), z.any());
    shape[key] = required.has(key) ? type : type.optional();
  }
  return z.object(shape).passthrough();
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

async function initMcpTools(mcpConfig, reservedNames) {
  const clients = [];
  const tools = {};
  const settled = await Promise.allSettled(Object.entries(mcpConfig || {}).map(([name, cfg]) => connectMcpClient(name, cfg)));
  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    const connected = result.value;
    clients.push(connected);
    let listed;
    try { listed = await connected.client.listTools(); } catch { continue; }
    for (const t of listed.tools || []) {
      if (reservedNames.has(t.name) || tools[t.name]) continue;
      tools[t.name] = makeTool({
        description: t.description || `${connected.name}:${t.name}`,
        inputSchema: jsonSchemaToZod(t.inputSchema || t.input_schema),
        execute: async (args) => {
          const out = await connected.client.callTool({ name: t.name, arguments: args || {} });
          if (Array.isArray(out?.content)) {
            const text = out.content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
            return text || JSON.stringify(out.content);
          }
          return JSON.stringify(out || {});
        },
      });
    }
  }
  return { clients, tools };
}

async function closeMcpClients(clients) {
  for (const { client, transport } of clients) {
    try { await client.close?.(); } catch { /* best-effort */ }
    try { await transport.close?.(); } catch { /* best-effort */ }
  }
}

function buildOllamaSettings(modelRow, effort) {
  const caps = modelRow?.capabilities || {};
  const settings = {
    keep_alive: "10m",
    options: { num_ctx: Number(caps.num_ctx) || defaultOllamaNumCtx(caps.parameter_size) },
  };
  if (caps.reasoning) settings.think = !!effort && effort !== "low";
  return settings;
}

export async function generateVercelResponse(systemPrompt, options = {}) {
  const resolved = options.model;
  const start = Date.now();
  const events = [];
  const texts = [];
  let usage = { inputTokens: 0, outputTokens: 0 };
  let mcpClients = [];

  try {
    const { provider, modelRow, modelFactory } = resolveVercelModel({
      db: options.db,
      dataDir: options.dataDir,
      providerId: resolved.providerId,
      modelName: resolved.modelName,
    });
    const languageModel = provider.provider_type === "ollama"
      ? modelFactory(resolved.modelName, buildOllamaSettings(modelRow, options.effort))
      : modelFactory(resolved.modelName);

    const builtIns = getVercelTools({
      allowedTools: options.allowedTools,
      skillNames: (options.skills || []).map((s) => s.name),
      dataDir: options.dataDir,
    });
    const { clients, tools: mcpTools } = await initMcpTools(options.mcpServers || {}, new Set(Object.keys(builtIns)));
    mcpClients = clients;
    const tools = { ...builtIns, ...mcpTools };

    const result = streamText({
      model: languageModel,
      system: systemPrompt,
      messages: options.messages || [],
      tools,
      stopWhen: stepCountIs(options.maxTurns || 30),
      abortSignal: options.abortSignal,
      onStepFinish: ({ text, toolCalls, toolResults, usage: stepUsage }) => {
        if (text?.trim()) {
          texts.push(text.trim());
          const ev = { type: "assistant", message: { content: [{ type: "text", text: text.trim() }] } };
          events.push(ev);
          options.onEvent?.(ev);
        }
        for (const call of toolCalls || []) {
          const ev = { type: "assistant", message: { content: [{ type: "tool_use", id: call.toolCallId, name: call.toolName, input: call.input || call.args }] } };
          events.push(ev);
          options.onEvent?.(ev);
        }
        for (const toolResult of toolResults || []) {
          const output = typeof toolResult.output === "string" ? toolResult.output : JSON.stringify(toolResult.output ?? toolResult.result ?? "");
          const ev = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: toolResult.toolCallId, content: output }] } };
          events.push(ev);
          options.onEvent?.(ev);
        }
        if (stepUsage) {
          usage.inputTokens += stepUsage.inputTokens || stepUsage.promptTokens || 0;
          usage.outputTokens += stepUsage.outputTokens || stepUsage.completionTokens || 0;
        }
      },
    });

    let streamedText = "";
    for await (const chunk of result.fullStream) {
      if (options.abortSignal?.aborted) break;
      if (chunk.type === "text-delta") streamedText += chunk.text || "";
      if (chunk.type === "reasoning-delta" || chunk.type === "reasoning") {
        const text = chunk.text || chunk.reasoning || "";
        if (text) {
          const ev = { type: "assistant", message: { content: [{ type: "thinking", text }] } };
          events.push(ev);
          options.onEvent?.(ev);
        }
      }
    }
    const totalUsage = await result.totalUsage.catch(() => null) ?? await result.usage.catch(() => null);
    if (totalUsage) {
      usage = {
        inputTokens: totalUsage.inputTokens ?? totalUsage.promptTokens ?? usage.inputTokens,
        outputTokens: totalUsage.outputTokens ?? totalUsage.completionTokens ?? usage.outputTokens,
      };
    }
    const finalText = (await result.text.catch(() => null)) || streamedText;
    if (finalText?.trim() && finalText.trim() !== texts[texts.length - 1]) texts.push(finalText.trim());
    const reference = `vercel:${resolved.providerId}:${resolved.modelName}`;
    const costUsd = estimateCost({ db: options.db, model: reference, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
    return {
      text: texts.join("\n\n"),
      events,
      usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, cost_usd: costUsd },
      durationMs: Date.now() - start,
      numTurns: texts.length,
      model: reference,
      effort: options.effort || null,
      sdk: "vercel",
      cancelled: !!options.abortSignal?.aborted,
    };
  } catch (err) {
    return {
      text: texts.join("\n\n") || null,
      events,
      usage: {},
      durationMs: Date.now() - start,
      numTurns: texts.length,
      model: resolved?.reference || null,
      effort: options.effort || null,
      sdk: "vercel",
      cancelled: !!options.abortSignal?.aborted,
      error: err.message || String(err),
    };
  } finally {
    await closeMcpClients(mcpClients);
  }
}
