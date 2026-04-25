import { Agent, MCPServerStdio, MCPServerStreamableHttp, Runner, setTracingDisabled } from "@openai/agents";
import { getOpenAITools } from "./ai-tools.js";
import { estimateCost } from "./cost.js";

process.env.OPENAI_AGENTS_DISABLE_TRACING ||= "1";
process.env.OPENAI_AGENTS_DONT_LOG_MODEL_DATA ||= "1";
process.env.OPENAI_AGENTS_DONT_LOG_TOOL_DATA ||= "1";
setTracingDisabled(true);

const runner = new Runner({ tracingDisabled: true, traceIncludeSensitiveData: false });

function coerceText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(coerceText).filter(Boolean).join("\n");
  if (typeof value === "object") {
    if (value.type === "text" && typeof value.text === "string") return value.text;
    if (Array.isArray(value.content)) return coerceText(value.content);
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

function parseToolInput(raw) {
  if (raw == null || typeof raw === "object") return raw || {};
  try { return JSON.parse(raw); } catch { return raw; }
}

function readUsage(usage = {}) {
  const inputTokens = usage.inputTokens ?? usage.input_tokens ?? 0;
  const outputTokens = usage.outputTokens ?? usage.output_tokens ?? 0;
  const details = usage.inputTokensDetails ?? usage.input_tokens_details;
  const cacheRead = Array.isArray(details)
    ? details.reduce((sum, d) => sum + (d?.cached_tokens || d?.cachedTokens || 0), 0)
    : (details?.cached_tokens || details?.cachedTokens || 0);
  return { inputTokens, outputTokens, cacheRead };
}

async function initMcpServers(mcpConfig = {}) {
  const entries = Object.entries(mcpConfig);
  const settled = await Promise.allSettled(entries.map(async ([name, cfg]) => {
    let server;
    if (cfg.type === "http" || cfg.type === "sse") {
      server = new MCPServerStreamableHttp({ name, url: cfg.url, cacheToolsList: true, ...(cfg.headers ? { headers: cfg.headers } : {}) });
    } else {
      server = new MCPServerStdio({
        name,
        fullCommand: cfg.args?.length ? `${cfg.command} ${cfg.args.join(" ")}` : cfg.command,
        cacheToolsList: true,
        env: { ...process.env, ...(cfg.env || {}) },
      });
    }
    await server.connect();
    return server;
  }));
  return {
    servers: settled.filter((r) => r.status === "fulfilled").map((r) => r.value),
    warnings: settled
      .map((result, index) => result.status === "rejected"
        ? { type: "runtime_warning", warning_kind: "mcp_init_failed", server: entries[index]?.[0], message: result.reason?.message || String(result.reason) }
        : null)
      .filter(Boolean),
  };
}

async function closeMcpServers(servers) {
  for (const server of servers) {
    try { await server.close(); } catch { /* best-effort */ }
  }
}

export async function generateOpenAIResponse(systemPrompt, options = {}) {
  const model = options.model?.model || options.model;
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set");
  const start = Date.now();
  const events = [];
  const texts = [];
  let usage = { inputTokens: 0, outputTokens: 0, cacheRead: 0 };
  let mcpServers = [];

  try {
    const mcpInit = await initMcpServers(options.mcpServers || {});
    mcpServers = mcpInit.servers;
    for (const warning of mcpInit.warnings) {
      events.push(warning);
      options.onEvent?.(warning);
    }
    const agent = new Agent({
      name: "Worklab",
      instructions: systemPrompt,
      model,
      tools: getOpenAITools(options.allowedTools, {
        skillNames: (options.skills || []).map((s) => s.name),
        dataDir: options.dataDir,
      }),
      mcpServers,
      modelSettings: {
        maxTokens: options.maxTokens || 16384,
        store: false,
        ...(options.effort && options.effort !== "low" ? { reasoning: { effort: options.effort === "max" ? "xhigh" : options.effort } } : {}),
      },
    });

    const input = options.messages?.length ? options.messages : [{ role: "user", content: "" }];
    const stream = await runner.run(agent, input, {
      stream: true,
      maxTurns: options.maxTurns || 30,
      signal: options.abortSignal,
    });

    for await (const event of stream) {
      if (options.abortSignal?.aborted) break;
      if (event.type === "run_item_stream_event") {
        if (event.name === "message_output_created") {
          const text = coerceText(event.item?.content || event.item?.rawItem?.content).trim();
          if (text) {
            texts.push(text);
            const ev = { type: "assistant", message: { content: [{ type: "text", text }] } };
            events.push(ev);
            options.onEvent?.(ev);
          }
        } else if (event.name === "tool_called") {
          const raw = event.item?.rawItem || {};
          const ev = { type: "assistant", message: { content: [{ type: "tool_use", id: raw.callId || raw.call_id || raw.id, name: raw.name, input: parseToolInput(raw.arguments ?? raw.input) }] } };
          events.push(ev);
          options.onEvent?.(ev);
        } else if (event.name === "tool_output") {
          const raw = event.item?.rawItem || {};
          const output = coerceText(event.item?.output ?? raw.output);
          const ev = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: raw.callId || raw.call_id || raw.id, content: output }] } };
          events.push(ev);
          options.onEvent?.(ev);
        }
      } else if (event.type === "raw_model_stream_event" && event.data?.type === "response_done") {
        usage = readUsage(event.data.response?.usage);
      }
    }

    const finalOutput = coerceText(stream.finalOutput).trim();
    if (finalOutput && finalOutput !== texts[texts.length - 1]) texts.push(finalOutput);
    const sdkUsage = readUsage(stream.runContext?.usage || {});
    if (sdkUsage.inputTokens || sdkUsage.outputTokens) usage = sdkUsage;
    const durationMs = Date.now() - start;
    const costUsd = estimateCost({ db: options.db, model: `openai:${model}`, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedTokens: usage.cacheRead });
    return {
      text: texts.join("\n\n"),
      events,
      usage: {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        cache_read_tokens: usage.cacheRead,
        cost_usd: costUsd,
      },
      durationMs,
      numTurns: texts.length,
      model,
      effort: options.effort || null,
      sdk: "openai",
      cancelled: !!options.abortSignal?.aborted,
    };
  } catch (err) {
    return {
      text: texts.join("\n\n") || null,
      events,
      usage: {},
      durationMs: Date.now() - start,
      numTurns: texts.length,
      model,
      effort: options.effort || null,
      sdk: "openai",
      cancelled: !!options.abortSignal?.aborted,
      error: err.message || String(err),
    };
  } finally {
    await closeMcpServers(mcpServers);
  }
}
