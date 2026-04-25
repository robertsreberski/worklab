import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { WORKLAB_RESULT_JSON_SCHEMA } from "./worklab-result.js";

function promptFromMessages(messages) {
  return Array.isArray(messages)
    ? messages.map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n\n")
    : String(messages || "");
}

function normalizeCliEvent(raw) {
  if (!raw || typeof raw !== "object") return { type: "cli_event", raw };
  if (raw.type === "assistant" || raw.type === "user" || raw.type === "result" || raw.type === "error") return raw;
  if (raw.type === "message" && raw.message) return { type: "assistant", message: raw.message };
  if (raw.type === "tool_call") {
    return { type: "assistant", message: { content: [{ type: "tool_use", id: raw.id, name: raw.name, input: raw.input || raw.arguments }] } };
  }
  if (raw.type === "tool_result") {
    return { type: "user", message: { content: [{ type: "tool_result", tool_use_id: raw.id || raw.tool_use_id, content: raw.output || raw.result || "" }] } };
  }
  return { type: "cli_event", raw };
}

function textFromEvent(raw) {
  if (typeof raw?.text === "string") return raw.text;
  if (typeof raw?.result === "string") return raw.result;
  if (typeof raw?.final_output === "string") return raw.final_output;
  if (typeof raw?.message?.content === "string") return raw.message.content;
  if (Array.isArray(raw?.message?.content)) {
    return raw.message.content.filter((part) => part?.type === "text").map((part) => part.text).join("");
  }
  return "";
}

export function buildCliCommand({ sdk, model, effort, cwd, schemaPath, systemPrompt, prompt }) {
  if (sdk === "claude-code") {
    return {
      command: "claude",
      args: [
        "-p",
        "--output-format", "stream-json",
        "--verbose",
        "--json-schema", schemaPath,
        "--model", model,
        "--append-system-prompt", systemPrompt,
        "--no-session-persistence",
        prompt,
      ],
      cwd,
    };
  }

  const args = [
    "exec",
    "--json",
    "--output-schema", schemaPath,
    "--model", model,
    "--cd", cwd,
    "--ephemeral",
  ];
  if (effort) args.push("--config", `model_reasoning_effort=${effort}`);
  args.push(prompt);
  return { command: "codex", args, cwd };
}

export async function generateCliResponse(systemPrompt, options = {}) {
  const start = Date.now();
  const resolved = options.model;
  const prompt = promptFromMessages(options.messages);
  const dir = mkdtempSync(join(tmpdir(), "worklab-cli-"));
  const schemaPath = join(dir, "worklab-result.schema.json");
  writeFileSync(schemaPath, JSON.stringify(WORKLAB_RESULT_JSON_SCHEMA));
  const commandSpec = buildCliCommand({
    sdk: resolved.sdk,
    model: resolved.model,
    effort: options.effort,
    cwd: options.cwd || process.cwd(),
    schemaPath,
    systemPrompt,
    prompt,
  });

  const events = [];
  const texts = [];
  let errorMessage = null;
  let usage = {};

  try {
    const child = spawn(commandSpec.command, commandSpec.args, {
      cwd: commandSpec.cwd,
      env: { ...process.env, WORKLAB_WORKSPACE: commandSpec.cwd },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stderr = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));

    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let raw;
      try {
        raw = JSON.parse(line);
      } catch {
        const ev = { type: "cli_stdout", text: line };
        events.push(ev);
        options.onEvent?.(ev);
        return;
      }
      const ev = normalizeCliEvent(raw);
      events.push(ev);
      options.onEvent?.(ev);
      const text = textFromEvent(raw);
      if (text) texts.push(text);
      if (raw.usage) usage = raw.usage;
      if (raw.type === "error") errorMessage = raw.message || raw.error || "cli error";
    });

    if (options.abortSignal) {
      const abort = () => child.kill("SIGTERM");
      if (options.abortSignal.aborted) abort();
      else options.abortSignal.addEventListener("abort", abort, { once: true });
    }

    const exitCode = await new Promise((resolve) => child.on("close", resolve));
    const stderrText = stderr.join("").trim();
    if (exitCode !== 0 && !errorMessage) errorMessage = stderrText || `${commandSpec.command} exited ${exitCode}`;
    return {
      text: texts.join("\n\n"),
      events,
      usage,
      durationMs: Date.now() - start,
      numTurns: texts.length,
      model: `${resolved.sdk}:${resolved.model}`,
      effort: options.effort || null,
      sdk: resolved.sdk,
      cancelled: !!options.abortSignal?.aborted,
      error: errorMessage,
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
      sdk: resolved?.sdk || "cli",
      cancelled: !!options.abortSignal?.aborted,
      error: err.message || String(err),
    };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
