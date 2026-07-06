import { describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateCodexAppResponse } from "@mono-agent/agent-runtime/ai/providers/codex-app.js";
import { createLiveInputQueue } from "../../core/live-input.js";
import { extractWorklabResult } from "../../core/worklab-result/contract.js";

function writeFakeCodexAppServer(dir) {
  const script = join(dir, "fake-codex-app-server.cjs");
  writeFileSync(script, `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const logPath = process.env.FAKE_CODEX_REQUEST_LOG;
const mode = process.env.FAKE_CODEX_MODE || "complete_after_steer";
let startedSent = false;
const rl = readline.createInterface({ input: process.stdin });
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
function record(value) { if (logPath) fs.appendFileSync(logPath, JSON.stringify(value) + "\\n"); }
function resultText(detail) {
  return JSON.stringify({
    schema: "worklab.v2",
    stage: "execute",
    decision: "advance",
    summary: "Done",
    details: detail,
    artifacts: {},
    blocking_issues: [],
    pending_actions: [],
    subtasks: []
  });
}
function complete(detail) {
  if (mode === "collab_event") {
    send({ method: "item/started", params: { threadId: "thread1", turnId: "turn1", item: { type: "collabAgentToolCall", id: "collab1", tool: "spawnAgent", status: "inProgress", prompt: "Inspect the router.", model: "gpt-5.4", reasoningEffort: "medium", receiverThreadIds: [] } } });
    send({ method: "item/completed", params: { threadId: "thread1", turnId: "turn1", item: { type: "collabAgentToolCall", id: "collab1", tool: "spawnAgent", status: "completed", prompt: "Inspect the router.", model: "gpt-5.4", reasoningEffort: "medium", receiverThreadIds: ["thread-helper"], agentsStates: [{ agentId: "helper", status: "completed" }] } } });
  }
  send({ method: "item/started", params: { threadId: "thread1", turnId: "turn1", item: { type: "commandExecution", id: "cmd1", command: "pwd", cwd: "/repo", processId: null, source: "exec", status: "inProgress", commandActions: [], aggregatedOutput: "", exitCode: null, durationMs: null } } });
  send({ method: "item/completed", params: { threadId: "thread1", turnId: "turn1", item: { type: "commandExecution", id: "cmd1", command: "pwd", cwd: "/repo", processId: null, source: "exec", status: "completed", commandActions: [], aggregatedOutput: "/repo\\n", exitCode: 0, durationMs: 3 } } });
  send({ method: "item/started", params: { threadId: "thread1", turnId: "turn1", item: { type: "mcpToolCall", id: "mcp1", server: "worklab", tool: "journal_append", status: "inProgress", arguments: { bullet: "checked pwd" }, result: null, error: null, durationMs: null } } });
  send({ method: "item/completed", params: { threadId: "thread1", turnId: "turn1", item: { type: "mcpToolCall", id: "mcp1", server: "worklab", tool: "journal_append", status: "completed", arguments: { bullet: "checked pwd" }, result: { content: [{ type: "text", text: "{\\"ok\\":true}" }], structuredContent: null, _meta: null }, error: null, durationMs: 2 } } });
  if (!fs.existsSync("artifact.txt")) fs.writeFileSync("artifact.txt", "one\\ntwo\\nthree\\n");
  send({ method: "item/started", params: { threadId: "thread1", turnId: "turn1", item: { type: "fileChange", id: "file1", status: "inProgress", changes: [{ path: "artifact.txt", kind: "update" }] } } });
  setTimeout(() => {
    fs.writeFileSync("artifact.txt", "one\\nTWO\\nthree\\nfour\\n");
    send({ method: "item/completed", params: { threadId: "thread1", turnId: "turn1", item: { type: "fileChange", id: "file1", status: "completed", changes: [{ path: "artifact.txt", kind: "update" }] } } });
    send({ method: "item/completed", params: { threadId: "thread1", turnId: "turn1", item: { type: "agentMessage", id: "msg1", text: resultText(detail), phase: null, memoryCitation: null } } });
    send({ method: "thread/tokenUsage/updated", params: { threadId: "thread1", turnId: "turn1", tokenUsage: { total: { totalTokens: 8, inputTokens: 5, cachedInputTokens: 1, outputTokens: 3, reasoningOutputTokens: 0 }, last: { totalTokens: 8, inputTokens: 5, cachedInputTokens: 1, outputTokens: 3, reasoningOutputTokens: 0 }, modelContextWindow: 1000 } } });
    send({ method: "turn/completed", params: { threadId: "thread1", turn: { id: "turn1", items: [], status: "completed", error: null, startedAt: 1, completedAt: 2, durationMs: 10 } } });
  }, 10);
}
function turnStarted() {
  startedSent = true;
  send({ method: "turn/started", params: { threadId: "thread1", turn: { id: "turn1", items: [], status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null } } });
}
rl.on("line", (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  record(request);
  if (request.method === "initialize") {
    send({ id: request.id, result: { userAgent: "fake", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "linux" } });
  } else if (request.method === "collaborationMode/list") {
    send({ id: request.id, result: { modes: [{ id: "default", label: "Default" }] } });
  } else if (request.method === "thread/start") {
    if (mode === "thread_start_timeout") return;
    if (mode === "thread_start_timeout_once") {
      const markerPath = logPath ? logPath + ".thread-start-seen" : "thread-start-seen";
      if (!fs.existsSync(markerPath)) {
        fs.writeFileSync(markerPath, "1");
        return;
      }
    }
    send({ id: request.id, result: { thread: { id: "thread1", forkedFromId: null, preview: "", ephemeral: true, modelProvider: "openai", createdAt: 1, updatedAt: 1, status: { type: "idle" }, path: null, cwd: request.params.cwd, cliVersion: "fake", source: "codex app-server", agentNickname: null, agentRole: null, gitInfo: null, name: null, turns: [] }, model: request.params.model, modelProvider: "openai", serviceTier: "fast", cwd: request.params.cwd, instructionSources: [], approvalPolicy: request.params.approvalPolicy, approvalsReviewer: "user", sandbox: { type: "dangerFullAccess" }, permissionProfile: null, reasoningEffort: request.params.config?.model_reasoning_effort || null } });
  } else if (request.method === "turn/start") {
    send({ id: request.id, result: { turn: { id: "turn1", items: [], status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null } } });
    if (mode === "delayed_turn_started") setTimeout(turnStarted, 100);
    else turnStarted();
    if (mode === "complete_immediately" || mode === "collab_event" || mode === "thread_start_timeout_once") setTimeout(() => complete("Initial"), 10);
  } else if (request.method === "turn/steer") {
    if (mode === "delayed_turn_started" && !startedSent) {
      send({ id: request.id, error: { code: -32000, message: "no active turn to steer" } });
      setTimeout(() => complete("Initial"), 10);
    } else if (mode === "not_steerable") {
      send({ id: request.id, error: { code: -32000, message: "not steerable", data: { info: { activeTurnNotSteerable: { turnKind: "review" } } } } });
      setTimeout(() => complete("Initial"), 10);
    } else {
      send({ id: request.id, result: { turnId: "turn1" } });
      setTimeout(() => complete("Guided: " + request.params.input[0].text), 10);
    }
  } else if (request.method === "turn/interrupt") {
    send({ id: request.id, result: {} });
  }
});
`, "utf8");
  chmodSync(script, 0o755);
  return script;
}

function readRequests(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function expectedLiveGuidance(text) {
  return [
    "Live guidance from the user:",
    text,
    "",
    "Apply this guidance before continuing. It may correct, narrow, or override your current approach.",
    "Keep satisfying the original task and existing comments except where this live guidance conflicts with them.",
    "When there is a conflict, the newest human live guidance wins. Do not discard the broader task unless the user explicitly asks to replace it.",
  ].join("\n");
}

describe("generateCodexAppResponse", () => {
  it("passes a caller-supplied output schema to Codex app-server turns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worklab-codex-app-"));
    const logPath = join(dir, "requests.jsonl");
    const script = writeFakeCodexAppServer(dir);
    const customSchema = {
      type: "object",
      additionalProperties: false,
      required: ["schema", "status"],
      properties: {
        schema: { type: "string", enum: ["custom.schema.v1"] },
        status: { type: "string" },
      },
    };
    try {
      const result = await generateCodexAppResponse("system", {
        model: { sdk: "codex", model: "gpt-5.5", reference: "codex:gpt-5.5" },
        effort: "low",
        messages: [{ role: "user", content: "do work" }],
        cwd: dir,
        permissionMode: "bypassPermissions",
        codexAppServerCommand: script,
        codexAppServerArgs: [],
        codexAppServerEnv: { FAKE_CODEX_REQUEST_LOG: logPath, FAKE_CODEX_MODE: "complete_immediately" },
        outputSchema: customSchema,
      });
      const requests = readRequests(logPath);
      const turnStart = requests.find((request) => request.method === "turn/start");

      expect(result.error).toBeNull();
      expect(result.diagnostics.codex_thread_start_timeout_ms).toBe(60_000);
      expect(turnStart.params.outputSchema).toEqual(customSchema);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults Codex fast mode on for GPT models", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worklab-codex-app-"));
    const logPath = join(dir, "requests.jsonl");
    const script = writeFakeCodexAppServer(dir);
    try {
      const result = await generateCodexAppResponse("system", {
        model: { sdk: "codex", model: "gpt-5.4-mini", reference: "codex:gpt-5.4-mini" },
        effort: "medium",
        messages: [{ role: "user", content: "do work" }],
        cwd: dir,
        permissionMode: "bypassPermissions",
        codexAppServerCommand: script,
        codexAppServerArgs: [],
        codexAppServerEnv: { FAKE_CODEX_REQUEST_LOG: logPath, FAKE_CODEX_MODE: "complete_immediately" },
      });
      const requests = readRequests(logPath);
      const threadStart = requests.find((request) => request.method === "thread/start");
      const turnStart = requests.find((request) => request.method === "turn/start");

      expect(result.error).toBeNull();
      expect(threadStart.params.serviceTier).toBe("fast");
      expect(threadStart.params.config).toMatchObject({
        service_tier: "fast",
        features: { fast_mode: true },
      });
      expect(turnStart.params.serviceTier).toBe("fast");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not request the fast service tier when fastMode is disabled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worklab-codex-app-"));
    const logPath = join(dir, "requests.jsonl");
    const script = writeFakeCodexAppServer(dir);
    try {
      const result = await generateCodexAppResponse("system", {
        model: { sdk: "codex", model: "gpt-5.5", reference: "codex:gpt-5.5" },
        effort: "medium",
        messages: [{ role: "user", content: "do work" }],
        cwd: dir,
        permissionMode: "bypassPermissions",
        fastMode: false,
        codexAppServerCommand: script,
        codexAppServerArgs: [],
        codexAppServerEnv: { FAKE_CODEX_REQUEST_LOG: logPath, FAKE_CODEX_MODE: "complete_immediately" },
      });
      const requests = readRequests(logPath);
      const threadStart = requests.find((request) => request.method === "thread/start");
      const turnStart = requests.find((request) => request.method === "turn/start");

      expect(result.error).toBeNull();
      expect(threadStart.params.serviceTier).toBeUndefined();
      expect(threadStart.params.config.service_tier).toBeUndefined();
      expect(threadStart.params.config.features.fast_mode).toBe(false);
      expect(turnStart.params.serviceTier).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enables Codex collaboration mode for native teammate subagents", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worklab-codex-app-"));
    const logPath = join(dir, "requests.jsonl");
    const script = writeFakeCodexAppServer(dir);
    const events = [];
    try {
      const result = await generateCodexAppResponse("system", {
        model: { sdk: "codex", model: "gpt-5.5", reference: "codex:gpt-5.5" },
        effort: "medium",
        messages: [{ role: "user", content: "do work" }],
        cwd: dir,
        permissionMode: "bypassPermissions",
        codexAppServerCommand: script,
        codexAppServerArgs: [],
        codexAppServerEnv: { FAKE_CODEX_REQUEST_LOG: logPath, FAKE_CODEX_MODE: "collab_event" },
        nativeSubagents: {
          provider: "codex",
          mode: "advisory",
          teammates: [{
            name: "helper",
            displayName: "Helper",
            description: "Reads focused code paths.",
            helperSystemPrompt: "You are the helper.",
            model: { model: "gpt-5.4-mini" },
            effort: "low",
          }],
        },
        onEvent: (event) => events.push(event),
      });
      const requests = readRequests(logPath);
      const turnStart = requests.find((request) => request.method === "turn/start");

      expect(result.error).toBeNull();
      expect(requests.some((request) => request.method === "collaborationMode/list")).toBe(true);
      expect(turnStart.params.collaborationMode).toMatchObject({
        mode: "default",
        teammates: [{
          name: "helper",
          model: "gpt-5.4-mini",
          reasoningEffort: "low",
        }],
      });
      expect(events).toContainEqual({
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: "collab1",
            name: "codex_spawnAgent",
            input: {
              prompt: "Inspect the router.",
              model: "gpt-5.4",
              reasoningEffort: "medium",
              receiverThreadIds: [],
            },
          }],
        },
      });
      expect(events).toContainEqual({
        type: "user",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "collab1",
            content: {
              status: "completed",
              receiverThreadIds: ["thread-helper"],
              agentsStates: [{ agentId: "helper", status: "completed" }],
            },
            is_error: false,
          }],
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("starts a Codex app-server turn and steers the active turn with live input", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worklab-codex-app-"));
    const logPath = join(dir, "requests.jsonl");
    const script = writeFakeCodexAppServer(dir);
    const events = [];
    const liveInput = createLiveInputQueue();
    try {
      const promise = generateCodexAppResponse("system instructions", {
        model: { sdk: "codex", model: "gpt-5.5", reference: "codex:gpt-5.5" },
        effort: "high",
        messages: [{ role: "user", content: "do work" }],
        cwd: dir,
        permissionMode: "bypassPermissions",
        liveInput,
        codexAppServerCommand: script,
        codexAppServerArgs: [],
        codexAppServerEnv: { FAKE_CODEX_REQUEST_LOG: logPath },
        onEvent: (event) => events.push(event),
      });

      for (let i = 0; i < 40; i += 1) {
        if (events.some((event) => event?.raw?.type === "turn_started")) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      liveInput.push({ id: "comment-1", body: "Please narrow the scope." });

      const result = await promise;
      const requests = readRequests(logPath);
      const threadStart = requests.find((request) => request.method === "thread/start");
      const turnStart = requests.find((request) => request.method === "turn/start");
      const steer = requests.find((request) => request.method === "turn/steer");

      expect(threadStart.params).toMatchObject({
        model: "gpt-5.5",
        developerInstructions: "system instructions",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      });
      expect(turnStart.params.input[0].text).toBe("do work");
      // outputSchema is only forwarded when the caller supplies one; this test
      // exercises the no-schema path.
      expect(turnStart.params.outputSchema).toBeUndefined();
      expect(steer.params).toMatchObject({
        threadId: "thread1",
        expectedTurnId: "turn1",
      });
      const expectedGuidance = expectedLiveGuidance("Please narrow the scope.");
      expect(steer.params.input).toEqual([{ type: "text", text: expectedGuidance, text_elements: [] }]);
      expect(result.error).toBeNull();
      const extracted = extractWorklabResult(result.events);
      expect(extracted.ok).toBe(true);
      expect(extracted.result.summary).toBe("Done");
      expect(extracted.result.details).toBe(`Guided: ${expectedGuidance}`);
      expect(result.usage).toMatchObject({ input_tokens: 5, output_tokens: 3, cache_read_tokens: 1 });
      expect(events).toContainEqual({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "cmd1", name: "command_execution", input: { command: "pwd" } }] },
      });
      expect(events).toContainEqual({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "cmd1", content: "/repo\n", is_error: false }] },
      });
      expect(events).toContainEqual({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "mcp1", name: "mcp__worklab__journal_append", input: { bullet: "checked pwd" } }] },
      });
      expect(events).toContainEqual({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "mcp1", content: [{ type: "text", text: "{\"ok\":true}" }], is_error: false }] },
      });
      expect(events).toContainEqual({
        type: "user",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "file1",
            content: {
              changes: [{
                path: "artifact.txt",
                kind: "update",
                line_stats: {
                  before_lines: 3,
                  after_lines: 4,
                  added_lines: 2,
                  removed_lines: 1,
                  changed_lines: 3,
                  hunks: [{ start: 2, end: 2 }, { start: 4, end: 4 }],
                },
              }],
              status: "completed",
              summary: { files: 1, added_lines: 2, removed_lines: 1, changed_lines: 3, unavailable_count: 0 },
            },
            is_error: false,
          }],
        },
      });
    } finally {
      liveInput.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retries thread/start with a fresh app-server after a startup timeout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worklab-codex-app-"));
    const logPath = join(dir, "requests.jsonl");
    const script = writeFakeCodexAppServer(dir);
    const events = [];
    try {
      const result = await generateCodexAppResponse("system", {
        model: { sdk: "codex", model: "gpt-5.5", reference: "codex:gpt-5.5" },
        effort: "medium",
        messages: [{ role: "user", content: "do work" }],
        cwd: dir,
        permissionMode: "bypassPermissions",
        codexAppServerCommand: script,
        codexAppServerArgs: [],
        codexAppServerEnv: { FAKE_CODEX_REQUEST_LOG: logPath, FAKE_CODEX_MODE: "thread_start_timeout_once" },
        codexThreadStartTimeoutMs: 20,
        codexThreadStartAttempts: 2,
        codexThreadStartBackoffMs: 0,
        onEvent: (event) => events.push(event),
      });
      const requests = readRequests(logPath);

      expect(result.error).toBeNull();
      expect(requests.filter((request) => request.method === "initialize")).toHaveLength(2);
      expect(requests.filter((request) => request.method === "thread/start")).toHaveLength(2);
      expect(result.diagnostics).toMatchObject({
        codex_thread_start_attempts: 2,
        codex_thread_start_retried: true,
        codex_thread_start_timeout_ms: 20,
      });
      expect(result.providerSessionId).toBe("thread1");
      expect(events).toContainEqual(expect.objectContaining({
        type: "runtime_warning",
        warning_kind: "codex_thread_start_retry",
      }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns retryable diagnostics when thread/start times out on every attempt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worklab-codex-app-"));
    const logPath = join(dir, "requests.jsonl");
    const script = writeFakeCodexAppServer(dir);
    try {
      const result = await generateCodexAppResponse("system", {
        model: { sdk: "codex", model: "gpt-5.5", reference: "codex:gpt-5.5" },
        effort: "medium",
        messages: [{ role: "user", content: "do work" }],
        cwd: dir,
        permissionMode: "bypassPermissions",
        codexAppServerCommand: script,
        codexAppServerArgs: [],
        codexAppServerEnv: { FAKE_CODEX_REQUEST_LOG: logPath, FAKE_CODEX_MODE: "thread_start_timeout" },
        codexThreadStartTimeoutMs: 20,
        codexThreadStartAttempts: 2,
        codexThreadStartBackoffMs: 0,
      });
      const requests = readRequests(logPath);

      expect(result.failureKind).toBe("provider_unavailable");
      expect(result.error).toBe("codex app-server request timed out: thread/start");
      expect(result.diagnostics).toMatchObject({
        codex_error_code: "codex_app_server_request_timeout",
        codex_request_method: "thread/start",
        codex_thread_start_attempts: 2,
        codex_thread_start_retried: true,
        codex_thread_start_timeout_ms: 20,
      });
      expect(requests.filter((request) => request.method === "thread/start")).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("waits for Codex turn/started before steering queued live input", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worklab-codex-app-"));
    const logPath = join(dir, "requests.jsonl");
    const script = writeFakeCodexAppServer(dir);
    const events = [];
    const liveInput = createLiveInputQueue();
    try {
      const env = { FAKE_CODEX_REQUEST_LOG: logPath, FAKE_CODEX_MODE: "delayed_turn_started" };
      const promise = generateCodexAppResponse("system", {
        model: { sdk: "codex", model: "gpt-5.5", reference: "codex:gpt-5.5" },
        effort: "medium",
        messages: [{ role: "user", content: "do work" }],
        cwd: dir,
        permissionMode: "bypassPermissions",
        liveInput,
        codexAppServerCommand: script,
        codexAppServerArgs: [],
        codexAppServerEnv: env,
        onEvent: (event) => events.push(event),
      });

      for (let i = 0; i < 50; i += 1) {
        if (readRequests(logPath).some((request) => request.method === "turn/start")) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      liveInput.push({ id: "comment-1", body: "Please wait for readiness." });

      const result = await promise;
      const requests = readRequests(logPath);
      const steers = requests.filter((request) => request.method === "turn/steer");
      const expectedGuidance = expectedLiveGuidance("Please wait for readiness.");

      expect(steers).toHaveLength(1);
      expect(steers[0].params.input).toEqual([{ type: "text", text: expectedGuidance, text_elements: [] }]);
      expect(result.error).toBeNull();
      const extracted = extractWorklabResult(result.events);
      expect(extracted.ok).toBe(true);
      expect(extracted.result.details).toBe(`Guided: ${expectedGuidance}`);
      expect(events).not.toContainEqual(expect.objectContaining({
        type: "runtime_warning",
        warning_kind: "live_input_rejected",
      }));
    } finally {
      liveInput.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits a runtime warning when Codex rejects steering for the active turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worklab-codex-app-"));
    const logPath = join(dir, "requests.jsonl");
    const script = writeFakeCodexAppServer(dir);
    const events = [];
    const liveInput = createLiveInputQueue();
    try {
      const env = { FAKE_CODEX_REQUEST_LOG: logPath, FAKE_CODEX_MODE: "not_steerable" };
      const promise = generateCodexAppResponse("system", {
        model: { sdk: "codex", model: "gpt-5.5", reference: "codex:gpt-5.5" },
        effort: "medium",
        messages: [{ role: "user", content: "do work" }],
        cwd: dir,
        permissionMode: "bypassPermissions",
        liveInput,
        codexAppServerCommand: script,
        codexAppServerArgs: [],
        codexAppServerEnv: env,
        onEvent: (event) => events.push(event),
      });

      for (let i = 0; i < 40; i += 1) {
        if (events.some((event) => event?.raw?.type === "turn_started")) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      liveInput.push({ id: "comment-1", body: "Please steer." });

      const result = await promise;
      expect(result.error).toBeNull();
      expect(events).toContainEqual(expect.objectContaining({
        type: "runtime_warning",
        warning_kind: "active_turn_not_steerable",
      }));
    } finally {
      liveInput.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("classifies premature codex app-server close as a retryable provider termination", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worklab-codex-app-"));
    const script = join(dir, "fake-codex-prematureclose.cjs");
    writeFileSync(script, `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
rl.on("line", (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    send({ id: request.id, result: { userAgent: "fake", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "linux" } });
  } else if (request.method === "thread/start") {
    send({ id: request.id, result: { thread: { id: "thread1", status: { type: "idle" }, cwd: request.params.cwd, modelProvider: "openai", cliVersion: "fake" }, model: request.params.model, modelProvider: "openai", serviceTier: "fast", cwd: request.params.cwd } });
  } else if (request.method === "turn/start") {
    send({ id: request.id, result: { turn: { id: "turn1", items: [], status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null } } });
    send({ method: "turn/started", params: { threadId: "thread1", turn: { id: "turn1", items: [], status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null } } });
    setTimeout(() => process.exit(1), 5);
  }
});
`, "utf8");
    chmodSync(script, 0o755);
    const events = [];
    const liveInput = createLiveInputQueue();
    try {
      const result = await generateCodexAppResponse("system", {
        model: { sdk: "codex", model: "gpt-5.5", reference: "codex:gpt-5.5" },
        effort: "low",
        messages: [{ role: "user", content: "do work" }],
        cwd: dir,
        permissionMode: "bypassPermissions",
        liveInput,
        codexAppServerCommand: script,
        codexAppServerArgs: [],
        codexAppServerEnv: {},
        onEvent: (event) => events.push(event),
      });
      expect(result.failureKind).toBe("provider_unavailable");
      expect(result.error).toBeTruthy();
      expect(result.diagnostics).toMatchObject({ codex_error_code: "codex_app_server_closed" });
    } finally {
      liveInput.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
