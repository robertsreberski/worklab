// Regression coverage for the seam that agent-runtime 0.15.x tightened and
// nothing in Worklab exercised: run-input.js always sends an explicit
// allowedTools array, and the direct Codex bridge rejects anything but the
// exact allow-all contract. The provider tests call generateCodexAppResponse
// directly without a tool policy (undefined -> allow-all), so they never saw
// the shape Worklab actually sends and every codex run failed with
// skipped_capability_mismatch / codex_tool_policy_unsupported.
//
// This drives core/ai.js#generateResponse so the projection in
// tool-policy-projection.js is genuinely in the path.
import { describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateResponse } from "../../core/ai.js";
import { WORKLAB_BUILTIN_TOOLS } from "../../core/builtin-tools.js";

function writeMinimalCodexAppServer(dir, { hangThreadStart = false } = {}) {
  const script = join(dir, "fake-codex-tool-policy.cjs");
  writeFileSync(script, `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const logPath = process.env.FAKE_CODEX_REQUEST_LOG;
const hangThreadStart = ${JSON.stringify(hangThreadStart)};
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
function record(value) { if (logPath) fs.appendFileSync(logPath, JSON.stringify(value) + "\\n"); }
function resultText() {
  return JSON.stringify({
    schema: "worklab.v2",
    stage: "execute",
    decision: "advance",
    summary: "Done",
    details: "ok",
    artifacts: {},
    blocking_issues: [],
    pending_actions: [],
    subtasks: []
  });
}
rl.on("line", (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  record(request);
  if (request.method === "initialize") {
    send({ id: request.id, result: { userAgent: "fake", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "linux" } });
  } else if (request.method === "thread/start") {
    if (!hangThreadStart) send({ id: request.id, result: { thread: { id: "thread1", status: { type: "idle" }, cwd: request.params.cwd, modelProvider: "openai", cliVersion: "fake" }, model: request.params.model, modelProvider: "openai", serviceTier: "fast", cwd: request.params.cwd } });
  } else if (request.method === "turn/start") {
    send({ id: request.id, result: { turn: { id: "turn1", items: [], status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null } } });
    send({ method: "turn/started", params: { threadId: "thread1", turn: { id: "turn1", items: [], status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null } } });
    send({ method: "item/completed", params: { threadId: "thread1", turnId: "turn1", item: { type: "agentMessage", id: "msg1", text: resultText(), phase: null, memoryCitation: null } } });
    send({ method: "turn/completed", params: { threadId: "thread1", turn: { id: "turn1", items: [], status: "completed", error: null, startedAt: 1, completedAt: 2, durationMs: 10 } } });
  }
});
`, "utf8");
  chmodSync(script, 0o755);
  return script;
}

async function runCodex(dir, policy, { events = [] } = {}) {
  const requestLog = join(dir, "requests.jsonl");
  return generateResponse("system", {
    model: "codex:gpt-5.5",
    // `codex:*` only resolves to the app-server bridge in cli execution mode,
    // which is what every Worklab codex agent runs (agents.execution_mode).
    executionMode: "cli",
    effort: "low",
    messages: [{ role: "user", content: "do work" }],
    cwd: dir,
    dataDir: dir,
    permissionMode: "bypassPermissions",
    settings: {},
    codexAppServerCommand: writeMinimalCodexAppServer(dir),
    codexAppServerArgs: [],
    codexAppServerEnv: { FAKE_CODEX_REQUEST_LOG: requestLog },
    onEvent: (event) => events.push(event),
    ...policy,
  });
}

function recordedRequest(dir, method) {
  const path = join(dir, "requests.jsonl");
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((request) => request.method === method) || null;
}

describe("codex tool policy projection", () => {
  // This is the exact shape run-input.js produces for builtin_allowlist_mode
  // 'all', which is the default for every agent.
  it("runs a codex turn with Worklab's allow-every-builtin policy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worklab-codex-policy-"));
    try {
      const result = await runCodex(dir, {
        allowedTools: [...WORKLAB_BUILTIN_TOOLS],
        disallowedTools: [],
      });

      expect(result.diagnostics?.codex_error_code).not.toBe("codex_tool_policy_unsupported");
      expect(result.failureKind).toBeFalsy();
      expect(result.text).toContain("worklab.v2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  // agent-runtime 0.15.2 unified the allow-all sentinel on includes("*"), so a
  // composed list reaches the provider instead of being rejected. This exact
  // call fails with codex_tool_policy_unsupported on 0.15.1.
  it("accepts a composed wildcard allowlist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worklab-codex-policy-wildcard-"));
    try {
      const result = await runCodex(dir, {
        allowedTools: ["*", "Read"],
        disallowedTools: [],
      });

      expect(result.diagnostics?.codex_error_code).not.toBe("codex_tool_policy_unsupported");
      expect(result.failureKind).toBeFalsy();
      expect(result.text).toContain("worklab.v2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  // The read-only planning policy adds disallowedTools, which fails closed on
  // direct Codex — a Codex planner could not run at all. It is routed through
  // Codex's native plan mode instead.
  it("runs the plan stage through Codex's native read-only sandbox", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worklab-codex-plan-"));
    const events = [];
    try {
      const result = await runCodex(dir, {
        // The shape applyPlanningToolPolicy produces for read_only_shell_allowlist.
        allowedTools: [
          "Read",
          "Glob",
          "Grep",
          "WebFetch",
          "WebSearch",
          "Agent",
          "Task",
          "TaskOutput",
          "TaskStop",
          "Skill",
          "Bash",
        ],
        disallowedTools: ["Write", "Edit"],
        toolPolicy: { planning: true, policy: "read_only_shell_allowlist" },
      }, { events });

      expect(result.diagnostics?.codex_error_code).not.toBe("codex_tool_policy_unsupported");
      expect(result.failureKind).toBeFalsy();

      // Assert the sandbox actually flipped. "The run didn't fail" would also
      // pass if permissionMode never reached the provider.
      const threadStart = recordedRequest(dir, "thread/start");
      expect(threadStart?.params?.sandbox).toBe("read-only");

      const warning = events.find((event) => event.warning_kind === "tool_policy_downgraded");
      expect(warning?.message).toContain("WebFetch, WebSearch");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  // A partial allowlist is a guarantee direct Codex cannot make, so the run
  // must still fail rather than be silently widened to allow-all.
  it("still refuses a partial allowlist instead of widening it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worklab-codex-policy-subset-"));
    try {
      const result = await runCodex(dir, {
        allowedTools: ["Read", "Grep"],
        disallowedTools: [],
      });

      expect(result.failureKind).toBe("skipped_capability_mismatch");
      expect(result.diagnostics?.codex_error_code).toBe("codex_tool_policy_unsupported");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  it("keeps Worklab's named tools on a Claude fallback from Codex", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worklab-codex-policy-fallback-"));
    const claudeCalls = [];
    try {
      const result = await generateResponse("system", {
        model: "codex:gpt-5.5",
        executionMode: "cli",
        effort: "low",
        fastMode: false,
        messages: [{ role: "user", content: "do work" }],
        cwd: dir,
        dataDir: dir,
        settings: {},
        allowedTools: [...WORKLAB_BUILTIN_TOOLS],
        disallowedTools: [],
        codexAppServerCommand: writeMinimalCodexAppServer(dir, { hangThreadStart: true }),
        codexAppServerArgs: [],
        codexThreadStartTimeoutMs: 50,
        codexThreadStartAttempts: 1,
        fallbackChain: [{
          model: { sdk: "claude", model: "claude-sonnet-4-6" },
          executionMode: "sdk",
        }],
        claudeAgentQuery: (params) => {
          claudeCalls.push(params);
          return {
            async *[Symbol.asyncIterator]() {
              yield {
                type: "result",
                result: "fallback ok",
                usage: {},
                duration_ms: 1,
                num_turns: 1,
              };
            },
            close: () => {},
          };
        },
      });

      expect(result.error).toBeFalsy();
      expect(result.text).toBe("fallback ok");
      expect(claudeCalls).toHaveLength(1);
      expect(claudeCalls[0].options.allowedTools).toEqual(WORKLAB_BUILTIN_TOOLS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);
});
