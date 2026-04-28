import { describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateCodexAppResponse } from "../../core/ai-codex-app.js";
import { createLiveInputQueue } from "../../core/live-input.js";

function writeFakeCodexAppServer(dir) {
  const script = join(dir, "fake-codex-app-server.cjs");
  writeFileSync(script, `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const logPath = process.env.FAKE_CODEX_REQUEST_LOG;
const mode = process.env.FAKE_CODEX_MODE || "complete_after_steer";
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
  send({ method: "item/completed", params: { threadId: "thread1", turnId: "turn1", item: { type: "agentMessage", id: "msg1", text: resultText(detail), phase: null, memoryCitation: null } } });
  send({ method: "thread/tokenUsage/updated", params: { threadId: "thread1", turnId: "turn1", tokenUsage: { total: { totalTokens: 8, inputTokens: 5, cachedInputTokens: 1, outputTokens: 3, reasoningOutputTokens: 0 }, last: { totalTokens: 8, inputTokens: 5, cachedInputTokens: 1, outputTokens: 3, reasoningOutputTokens: 0 }, modelContextWindow: 1000 } } });
  send({ method: "turn/completed", params: { threadId: "thread1", turn: { id: "turn1", items: [], status: "completed", error: null, startedAt: 1, completedAt: 2, durationMs: 10 } } });
}
rl.on("line", (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  record(request);
  if (request.method === "initialize") {
    send({ id: request.id, result: { userAgent: "fake", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "linux" } });
  } else if (request.method === "thread/start") {
    send({ id: request.id, result: { thread: { id: "thread1", forkedFromId: null, preview: "", ephemeral: true, modelProvider: "openai", createdAt: 1, updatedAt: 1, status: { type: "idle" }, path: null, cwd: request.params.cwd, cliVersion: "fake", source: "codex app-server", agentNickname: null, agentRole: null, gitInfo: null, name: null, turns: [] }, model: request.params.model, modelProvider: "openai", serviceTier: "fast", cwd: request.params.cwd, instructionSources: [], approvalPolicy: request.params.approvalPolicy, approvalsReviewer: "user", sandbox: { type: "dangerFullAccess" }, permissionProfile: null, reasoningEffort: request.params.config?.model_reasoning_effort || null } });
  } else if (request.method === "turn/start") {
    send({ id: request.id, result: { turn: { id: "turn1", items: [], status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null } } });
    send({ method: "turn/started", params: { threadId: "thread1", turn: { id: "turn1", items: [], status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null } } });
    if (mode === "complete_immediately") setTimeout(() => complete("Initial"), 10);
  } else if (request.method === "turn/steer") {
    if (mode === "not_steerable") {
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
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

describe("generateCodexAppResponse", () => {
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
      expect(turnStart.params.outputSchema.type).toBe("object");
      expect(steer.params).toMatchObject({
        threadId: "thread1",
        expectedTurnId: "turn1",
      });
      expect(steer.params.input).toEqual([{ type: "text", text: "Please narrow the scope.", text_elements: [] }]);
      expect(result.error).toBeNull();
      expect(result.worklabResult.summary).toBe("Done");
      expect(result.worklabResult.details).toBe("Guided: Please narrow the scope.");
      expect(result.usage).toMatchObject({ input_tokens: 5, output_tokens: 3, cache_read_tokens: 1 });
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
});
