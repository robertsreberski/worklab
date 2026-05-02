import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildCliCommand, generateCliResponse } from "../../ai/providers/claude-cli.js";
import { parseModelReference } from "../../core/ai.js";
import { WORKLAB_RESULT_JSON_SCHEMA } from "../../ai/result/contract.js";
import { buildExecuteSystemPrompt } from "../../agent/prompt/system-prompt.js";
import { loadSkills } from "../../core/skills.js";

describe("CLI provider adapters", () => {
  it("parses Claude Code and Codex model references", () => {
    expect(parseModelReference("claude-code:claude-sonnet-4-6")).toMatchObject({
      sdk: "claude-code",
      model: "claude-sonnet-4-6",
    });
    expect(parseModelReference("codex:gpt-5.5")).toMatchObject({
      sdk: "codex",
      model: "gpt-5.5",
    });
  });

  it("generates Claude Code stream-json command with inline schema, system prompt, and prompt separator", () => {
    const cmd = buildCliCommand({
      sdk: "claude-code",
      model: "claude-sonnet-4-6",
      cwd: "/repo",
      schemaPath: "/tmp/schema.json",
      systemPrompt: "system",
      prompt: "do work",
    });
    expect(cmd.command).toBe("claude");
    expect(cmd.cwd).toBe("/repo");
    expect(cmd.args).toEqual(expect.arrayContaining([
      "-p",
      "--output-format", "stream-json",
      "--model", "claude-sonnet-4-6",
      "--append-system-prompt", "system",
      "--no-session-persistence",
    ]));
    expect(cmd.args).not.toContain("--max-turns");
    const schemaIndex = cmd.args.indexOf("--json-schema");
    expect(schemaIndex).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(cmd.args[schemaIndex + 1])).toEqual(WORKLAB_RESULT_JSON_SCHEMA);
    expect(cmd.args[schemaIndex + 1]).not.toBe("/tmp/schema.json");
    expect(cmd.args.slice(-2)).toEqual(["--", "do work"]);
  });

  it("maps Claude Code MCP, effort, permissions, and tool allowlists to CLI flags", () => {
    const cmd = buildCliCommand({
      sdk: "claude-code",
      model: "claude-sonnet-4-6",
      effort: "high",
      cwd: "/repo",
      schemaPath: "/tmp/schema.json",
      systemPrompt: "system",
      prompt: "do work",
      mcpConfigPath: "/tmp/mcp.json",
      mcpServers: { worklab: { command: "/bin/sh" } },
      allowedTools: ["Read", "Bash"],
      disallowedTools: ["WebSearch"],
      permissionMode: "bypassPermissions",
      maxTurns: 12,
      skillDirs: ["/tmp/worklab-skills"],
    });
    expect(cmd.args).toEqual(expect.arrayContaining([
      "--effort", "high",
      "--permission-mode", "bypassPermissions",
      "--max-turns", "12",
      "--add-dir", "/tmp/worklab-skills",
      "--tools", "Read,Bash",
      "--allowedTools", "Read Bash mcp__worklab__*",
      "--disallowedTools", "WebSearch",
      "--mcp-config", "/tmp/mcp.json",
      "--strict-mcp-config",
    ]));
    expect(cmd.args.slice(-2)).toEqual(["--", "do work"]);
  });

  it("generates Codex exec JSON command with schema, cwd, and effort", () => {
    const cmd = buildCliCommand({
      sdk: "codex",
      model: "gpt-5.5",
      effort: "high",
      cwd: "/repo",
      schemaPath: "/tmp/schema.json",
      systemPrompt: "system",
      prompt: "do work",
    });
    expect(cmd.command).toBe("codex");
    expect(cmd.cwd).toBe("/repo");
    expect(cmd.args).toEqual(expect.arrayContaining([
      "exec",
      "--json",
      "--output-schema", "/tmp/schema.json",
      "--model", "gpt-5.5",
      "--cd", "/repo",
      "--ephemeral",
      "--skip-git-repo-check",
      "--config", "service_tier=\"fast\"",
      "--config", "features.fast_mode=true",
      "--config", "model_reasoning_effort=high",
      "--config", "model_reasoning_summary=\"auto\"",
    ]));
    expect(cmd.args.at(-1)).toBe("system\n\ndo work");
  });

  it("maps Codex permissions and MCP servers to exec flags/config overrides", () => {
    const cmd = buildCliCommand({
      sdk: "codex",
      model: "gpt-5.5",
      effort: "medium",
      cwd: "/repo",
      schemaPath: "/tmp/schema.json",
      systemPrompt: "system",
      prompt: "do work",
      permissionMode: "bypassPermissions",
      mcpServers: { worklab: { command: "/bin/sh", args: ["-lc", "node server.js"], env: { WORKLAB_RUN_ID: "run_1" } } },
    });
    expect(cmd.args).toEqual(expect.arrayContaining([
      "--dangerously-bypass-approvals-and-sandbox",
      "--config", "service_tier=\"fast\"",
      "--config", "features.fast_mode=true",
      "--config", "mcp_servers.worklab.command=\"/bin/sh\"",
      "--config", "mcp_servers.worklab.args=[\"-lc\", \"node server.js\"]",
      "--config", "mcp_servers.worklab.env.WORKLAB_RUN_ID=\"run_1\"",
      "--config", "mcp_servers.worklab.enabled=true",
    ]));
    expect(cmd.args.at(-1)).toBe("system\n\ndo work");
  });

  it("passes the pre-normalized effort through to Codex verbatim", () => {
    // The caller (core/ai.js#generateResponse) is responsible for
    // normalizing the reasoning effort against the model's capabilities
    // before invoking the provider. buildCliCommand therefore trusts the
    // value it receives.
    const cmd = buildCliCommand({
      sdk: "codex",
      model: "gpt-5.5",
      effort: "xhigh",
      cwd: "/repo",
      schemaPath: "/tmp/schema.json",
      systemPrompt: "system",
      prompt: "do work",
    });
    expect(cmd.args).toContain("model_reasoning_effort=xhigh");
  });

  it("does not request Codex reasoning summaries when effort is disabled", () => {
    const cmd = buildCliCommand({
      sdk: "codex",
      model: "gpt-5.5",
      effort: "none",
      cwd: "/repo",
      schemaPath: "/tmp/schema.json",
      systemPrompt: "system",
      prompt: "do work",
    });
    expect(cmd.args).toContain("model_reasoning_effort=none");
    expect(cmd.args).not.toContain("model_reasoning_summary=\"auto\"");
  });

  it("treats exit 0 with no CLI output as a retryable provider termination", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worklab-fake-cli-"));
    const fakeClaude = join(dir, "claude");
    const originalPath = process.env.PATH;
    writeFileSync(fakeClaude, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeClaude, 0o755);
    process.env.PATH = `${dir}:${originalPath || ""}`;
    try {
      const result = await generateCliResponse("system", {
        model: { sdk: "claude-code", model: "fake" },
        messages: [{ role: "user", content: "do work" }],
        cwd: process.cwd(),
      });
      expect(result.text).toBe("");
      expect(result.error).toBe("claude completed without final output");
      expect(result.failureKind).toBe("provider_unavailable");
      expect(result.diagnostics).toMatchObject({ pi_error_code: "cli_stream_terminated" });
    } finally {
      process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats CLI result error subtypes as adapter errors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worklab-fake-cli-"));
    const fakeClaude = join(dir, "claude");
    const originalPath = process.env.PATH;
    const events = [
      { type: "assistant", message: { content: [{ type: "text", text: "Working..." }] } },
      { type: "result", subtype: "error_max_turns", is_error: false, usage: { input_tokens: 1, output_tokens: 2 } },
    ];
    writeFileSync(fakeClaude, `#!/bin/sh
${events.map((event) => `printf '%s\\n' '${JSON.stringify(event)}'`).join("\n")}
exit 0
`);
    chmodSync(fakeClaude, 0o755);
    process.env.PATH = `${dir}:${originalPath || ""}`;
    try {
      const result = await generateCliResponse("system", {
        model: { sdk: "claude-code", model: "fake" },
        messages: [{ role: "user", content: "do work" }],
        cwd: process.cwd(),
      });
      expect(result.error).toBe("Claude Code stopped before final output: max turns reached");
      expect(result.failureKind).toBe("usage_limit");
      expect(result.text).toBe("Working...");
    } finally {
      process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("formats structured result objects from CLI result events", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worklab-fake-cli-"));
    const fakeClaude = join(dir, "claude");
    const originalPath = process.env.PATH;
    const structured = {
      schema: "worklab.v2",
      stage: "execute",
      decision: "advance",
      summary: "ok",
      details: "",
      artifacts: {},
      blocking_issues: [],
      pending_actions: [],
      questions: [],
      subtasks: [],
    };
    writeFileSync(fakeClaude, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ type: "result", result: structured })}'\nexit 0\n`);
    chmodSync(fakeClaude, 0o755);
    process.env.PATH = `${dir}:${originalPath || ""}`;
    try {
      const result = await generateCliResponse("system", {
        model: { sdk: "claude-code", model: "fake" },
        messages: [{ role: "user", content: "do work" }],
        cwd: process.cwd(),
      });
      expect(result.error).toBeNull();
      expect(result.text).toBe("ok");
      expect(result.numTurns).toBe(1);
    } finally {
      process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("extracts Claude Code StructuredOutput tool input without requiring final text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worklab-fake-cli-"));
    const fakeClaude = join(dir, "claude");
    const originalPath = process.env.PATH;
    const structured = {
      schema: "worklab.v2",
      stage: "execute",
      decision: "advance",
      summary: "structured ok",
      details: "",
      artifacts: {},
      blocking_issues: [],
      pending_actions: [],
      questions: [],
      subtasks: [],
    };
    const event = {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "out", name: "StructuredOutput", input: structured }] },
    };
    writeFileSync(fakeClaude, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(event)}'\nexit 0\n`);
    chmodSync(fakeClaude, 0o755);
    process.env.PATH = `${dir}:${originalPath || ""}`;
    try {
      const result = await generateCliResponse("system", {
        model: { sdk: "claude-code", model: "fake" },
        messages: [{ role: "user", content: "do work" }],
        cwd: process.cwd(),
      });
      expect(result.error).toBeNull();
      expect(result.text).toBe("structured ok");
      expect(result.worklabResult).toMatchObject(structured);
      expect(result.structuredResultSource).toBe("StructuredOutput");
      expect(result.numTurns).toBe(1);
    } finally {
      process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deduplicates repeated assistant and result text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worklab-fake-cli-"));
    const fakeClaude = join(dir, "claude");
    const originalPath = process.env.PATH;
    writeFileSync(fakeClaude, `#!/bin/sh
printf '%s\\n' '${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } })}'
printf '%s\\n' '${JSON.stringify({ type: "result", result: "Done." })}'
exit 0
`);
    chmodSync(fakeClaude, 0o755);
    process.env.PATH = `${dir}:${originalPath || ""}`;
    try {
      const result = await generateCliResponse("system", {
        model: { sdk: "claude-code", model: "fake" },
        messages: [{ role: "user", content: "do work" }],
        cwd: process.cwd(),
      });
      expect(result.error).toBeNull();
      expect(result.text).toBe("Done.");
      expect(result.numTurns).toBe(1);
    } finally {
      process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("formats invalid schema errors without dumping raw JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worklab-fake-cli-"));
    const fakeCodex = join(dir, "codex");
    const originalPath = process.env.PATH;
    const err = {
      type: "error",
      error: {
        type: "invalid_request_error",
        code: "invalid_json_schema",
        message: "Invalid schema for response_format codex_output_schema",
        param: "text.format.schema",
      },
    };
    writeFileSync(fakeCodex, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(err)}' >&2\nexit 1\n`);
    chmodSync(fakeCodex, 0o755);
    process.env.PATH = `${dir}:${originalPath || ""}`;
    try {
      const result = await generateCliResponse("system", {
        model: { sdk: "codex", model: "fake" },
        messages: [{ role: "user", content: "do work" }],
        cwd: process.cwd(),
      });
      expect(result.error).toBe("Invalid response schema (text.format.schema): Invalid schema for response_format codex_output_schema");
    } finally {
      process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes a sample skill, tools, and mock MCP config through the Claude Code smoke path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worklab-fake-cli-"));
    const fakeClaude = join(dir, "claude");
    const capturePrefix = join(dir, "capture");
    const skillsDir = join(dir, "skills");
    const originalPath = process.env.PATH;
    const originalCapture = process.env.WORKLAB_FAKE_CLI_CAPTURE;
    mkdirSync(join(skillsDir, "sample-smoke"), { recursive: true });
    writeFileSync(join(skillsDir, "sample-smoke", "SKILL.md"), `---
name: sample-smoke
trigger: smoke test skill
priority: always
---
SAMPLE_SKILL_BODY: verify this skill reaches the CLI system prompt.
`);
    const systemPrompt = buildExecuteSystemPrompt({
      agent: { name: "smoke-agent", instructions: "You are a smoke-test agent." },
      task: { id: "task-smoke", title: "Smoke test", stage: "execute", instructions: "Return a structured result." },
      skills: loadSkills(skillsDir),
      memory: "",
      journalTail: "",
      comments: [],
      pinnedKb: [],
    });
    const structured = {
      schema: "worklab.v2",
      stage: "execute",
      decision: "advance",
      summary: "ok",
      details: "",
      artifacts: {},
      blocking_issues: [],
      pending_actions: [],
      questions: [],
      subtasks: [],
    };
    writeFileSync(fakeClaude, `#!/bin/sh
capture="$WORKLAB_FAKE_CLI_CAPTURE"
printf '%s\\n' "$@" > "$capture.args"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--mcp-config" ]; then
    shift
    cat "$1" > "$capture.mcp"
  fi
  shift
done
printf '%s\\n' '${JSON.stringify({ type: "result", result: structured })}'
exit 0
`);
    chmodSync(fakeClaude, 0o755);
    process.env.PATH = `${dir}:${originalPath || ""}`;
    process.env.WORKLAB_FAKE_CLI_CAPTURE = capturePrefix;
    try {
      const result = await generateCliResponse(systemPrompt, {
        model: { sdk: "claude-code", model: "fake" },
        messages: [{ role: "user", content: "do work" }],
        cwd: process.cwd(),
        skills: loadSkills(skillsDir),
        allowedTools: ["Read", "Bash"],
        disallowedTools: ["WebSearch"],
        permissionMode: "bypassPermissions",
        mcpServers: {
          mock: {
            command: "/bin/sh",
            args: ["-lc", "node mock-mcp.js"],
            env: { WORKLAB_RUN_ID: "run_1" },
          },
        },
      });
      const argsText = readFileSync(`${capturePrefix}.args`, "utf8");
      const args = argsText.trim().split("\n");
      const mcpConfig = JSON.parse(readFileSync(`${capturePrefix}.mcp`, "utf8"));
      expect(result.error).toBeNull();
      expect(argsText).toContain("SAMPLE_SKILL_BODY");
      expect(argsText).toContain(`Worklab skills root: ${resolve(skillsDir)}`);
      expect(args).toEqual(expect.arrayContaining([
        "--add-dir",
        resolve(skillsDir),
        "--tools",
        "Read,Bash",
        "--allowedTools",
        "Read Bash mcp__mock__*",
        "--disallowedTools",
        "WebSearch",
        "--mcp-config",
        "--strict-mcp-config",
      ]));
      expect(args.slice(-2)).toEqual(["--", "do work"]);
      expect(mcpConfig).toEqual({
        mcpServers: {
          mock: {
            command: "/bin/sh",
            args: ["-lc", "node mock-mcp.js"],
            env: { WORKLAB_RUN_ID: "run_1" },
          },
        },
      });
    } finally {
      process.env.PATH = originalPath;
      if (originalCapture == null) delete process.env.WORKLAB_FAKE_CLI_CAPTURE;
      else process.env.WORKLAB_FAKE_CLI_CAPTURE = originalCapture;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes a sample skill and mock MCP config through the Codex smoke path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worklab-fake-cli-"));
    const fakeCodex = join(dir, "codex");
    const capturePrefix = join(dir, "capture");
    const skillsDir = join(dir, "skills");
    const originalPath = process.env.PATH;
    const originalCapture = process.env.WORKLAB_FAKE_CLI_CAPTURE;
    mkdirSync(join(skillsDir, "sample-codex-smoke"), { recursive: true });
    writeFileSync(join(skillsDir, "sample-codex-smoke", "SKILL.md"), `---
name: sample-codex-smoke
trigger: codex smoke test skill
priority: always
---
SAMPLE_CODEX_SKILL_BODY: verify this skill reaches the Codex prompt.
`);
    const systemPrompt = buildExecuteSystemPrompt({
      agent: { name: "codex-smoke-agent", instructions: "You are a Codex smoke-test agent." },
      task: { id: "task-codex-smoke", title: "Codex smoke test", stage: "execute", instructions: "Return a structured result." },
      skills: loadSkills(skillsDir),
      memory: "",
      journalTail: "",
      comments: [],
      pinnedKb: [],
    });
    const structured = {
      schema: "worklab.v2",
      stage: "execute",
      decision: "advance",
      summary: "ok",
      details: "",
      artifacts: {},
      blocking_issues: [],
      pending_actions: [],
      subtasks: [],
    };
    writeFileSync(fakeCodex, `#!/bin/sh
capture="$WORKLAB_FAKE_CLI_CAPTURE"
printf '%s\\n' "$@" > "$capture.args"
printf '%s\\n' '${JSON.stringify({ type: "result", result: structured })}'
exit 0
`);
    chmodSync(fakeCodex, 0o755);
    process.env.PATH = `${dir}:${originalPath || ""}`;
    process.env.WORKLAB_FAKE_CLI_CAPTURE = capturePrefix;
    try {
      const result = await generateCliResponse(systemPrompt, {
        model: { sdk: "codex", model: "fake" },
        messages: [{ role: "user", content: "do work" }],
        cwd: process.cwd(),
        permissionMode: "plan",
        mcpServers: {
          mock: {
            command: "/bin/sh",
            args: ["-lc", "node mock-mcp.js"],
            env: { WORKLAB_RUN_ID: "run_1" },
          },
        },
      });
      const argsText = readFileSync(`${capturePrefix}.args`, "utf8");
      const args = argsText.trim().split("\n");
      expect(result.error).toBeNull();
      expect(argsText).toContain("SAMPLE_CODEX_SKILL_BODY");
      expect(argsText).toContain("do work");
      expect(args).toEqual(expect.arrayContaining([
        "exec",
        "--json",
        "--sandbox",
        "read-only",
        "--config",
        "mcp_servers.mock.command=\"/bin/sh\"",
        "mcp_servers.mock.args=[\"-lc\", \"node mock-mcp.js\"]",
        "mcp_servers.mock.env.WORKLAB_RUN_ID=\"run_1\"",
        "mcp_servers.mock.enabled=true",
        "mcp_servers.mock.required=false",
      ]));
    } finally {
      process.env.PATH = originalPath;
      if (originalCapture == null) delete process.env.WORKLAB_FAKE_CLI_CAPTURE;
      else process.env.WORKLAB_FAKE_CLI_CAPTURE = originalCapture;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("normalizes Codex MCP tool events from item streams", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worklab-fake-cli-"));
    const fakeCodex = join(dir, "codex");
    const originalPath = process.env.PATH;
    const structured = {
      schema: "worklab.v2",
      stage: "execute",
      decision: "advance",
      summary: "ok",
      details: "",
      artifacts: {},
      blocking_issues: [],
      pending_actions: [],
      subtasks: [],
    };
    const events = [
      {
        type: "item.started",
        item: {
          id: "item_tool",
          type: "mcp_tool_call",
          server: "sample",
          tool: "sample_echo",
          arguments: { text: "smoke" },
          status: "in_progress",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "item_tool",
          type: "mcp_tool_call",
          server: "sample",
          tool: "sample_echo",
          arguments: { text: "smoke" },
          result: { content: [{ type: "text", text: "{\"echoed\":\"smoke\"}" }] },
          status: "completed",
        },
      },
      { type: "item.completed", item: { id: "item_msg", type: "agent_message", text: JSON.stringify(structured) } },
    ];
    writeFileSync(fakeCodex, `#!/bin/sh
${events.map((event) => `printf '%s\\n' '${JSON.stringify(event)}'`).join("\n")}
exit 0
`);
    chmodSync(fakeCodex, 0o755);
    process.env.PATH = `${dir}:${originalPath || ""}`;
    try {
      const result = await generateCliResponse("system", {
        model: { sdk: "codex", model: "fake" },
        messages: [{ role: "user", content: "do work" }],
        cwd: process.cwd(),
      });
      expect(result.error).toBeNull();
      expect(result.events[0]).toEqual({
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: "item_tool",
            name: "mcp__sample__sample_echo",
            input: { text: "smoke" },
          }],
        },
      });
      expect(result.events[1]).toMatchObject({
        type: "user",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "item_tool",
            is_error: false,
          }],
        },
      });
      expect(result.events[2]).toMatchObject({
        type: "worklab_result_candidate",
        source: "agent_message",
        worklab_result: structured,
      });
      expect(result.text).toBe("ok");
    } finally {
      process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("normalizes Codex file change item streams as file edit tool events", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worklab-fake-cli-"));
    const fakeCodex = join(dir, "codex");
    const originalPath = process.env.PATH;
    const structured = {
      schema: "worklab.v2",
      stage: "execute",
      decision: "advance",
      summary: "ok",
      details: "",
      artifacts: {},
      blocking_issues: [],
      pending_actions: [],
      subtasks: [],
    };
    const changes = [{ path: "/workspace/catching-up/build_wp_p2_tree.py", kind: "update" }];
    const events = [
      { type: "item.started", item: { id: "item_file", type: "file_change", changes, status: "in_progress" } },
      { type: "item.completed", item: { id: "item_file", type: "file_change", changes, status: "completed" } },
      { type: "item.completed", item: { id: "item_msg", type: "agent_message", text: JSON.stringify(structured) } },
    ];
    writeFileSync(fakeCodex, `#!/bin/sh
${events.map((event) => `printf '%s\\n' '${JSON.stringify(event)}'`).join("\n")}
exit 0
`);
    chmodSync(fakeCodex, 0o755);
    process.env.PATH = `${dir}:${originalPath || ""}`;
    try {
      const result = await generateCliResponse("system", {
        model: { sdk: "codex", model: "fake" },
        messages: [{ role: "user", content: "do work" }],
        cwd: process.cwd(),
      });
      expect(result.error).toBeNull();
      expect(result.events[0]).toEqual({
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: "item_file",
            name: "file_edit",
            input: { changes, status: "in_progress" },
          }],
        },
      });
      expect(result.events[1]).toEqual({
        type: "user",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "item_file",
            content: { changes, status: "completed" },
            is_error: false,
          }],
        },
      });
    } finally {
      process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adds best-effort line stats to completed Codex file edits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worklab-fake-cli-"));
    const fakeCodex = join(dir, "codex");
    const targetFile = join(dir, "edited.txt");
    const originalPath = process.env.PATH;
    writeFileSync(targetFile, "one\ntwo\nthree\n");
    const structured = {
      schema: "worklab.v2",
      stage: "execute",
      decision: "advance",
      summary: "ok",
      details: "",
      artifacts: {},
      blocking_issues: [],
      pending_actions: [],
      subtasks: [],
    };
    const changes = [{ path: targetFile, kind: "update" }];
    const started = { type: "item.started", item: { id: "item_file", type: "file_change", changes, status: "in_progress" } };
    const completed = { type: "item.completed", item: { id: "item_file", type: "file_change", changes, status: "completed" } };
    const final = { type: "item.completed", item: { id: "item_msg", type: "agent_message", text: JSON.stringify(structured) } };
    writeFileSync(fakeCodex, `#!/bin/sh
printf '%s\\n' '${JSON.stringify(started)}'
sleep 0.2
cat > ${JSON.stringify(targetFile)} <<'EOF_EDITED'
one
TWO
three
four
EOF_EDITED
printf '%s\\n' '${JSON.stringify(completed)}'
printf '%s\\n' '${JSON.stringify(final)}'
exit 0
`);
    chmodSync(fakeCodex, 0o755);
    process.env.PATH = `${dir}:${originalPath || ""}`;
    try {
      const result = await generateCliResponse("system", {
        model: { sdk: "codex", model: "fake" },
        messages: [{ role: "user", content: "do work" }],
        cwd: dir,
      });
      expect(result.error).toBeNull();
      expect(result.events[1]).toMatchObject({
        type: "user",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "item_file",
            content: {
              status: "completed",
              summary: { files: 1, added_lines: 2, removed_lines: 1, changed_lines: 3, unavailable_count: 0 },
              changes: [{
                path: targetFile,
                kind: "update",
                line_stats: {
                  before_lines: 3,
                  after_lines: 4,
                  added_lines: 2,
                  removed_lines: 1,
                  changed_lines: 3,
                },
              }],
            },
            is_error: false,
          }],
        },
      });
    } finally {
      process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("normalizes Codex reasoning summary events without using them as final text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worklab-fake-cli-"));
    const fakeCodex = join(dir, "codex");
    const originalPath = process.env.PATH;
    const structured = {
      schema: "worklab.v2",
      stage: "execute",
      decision: "advance",
      summary: "ok",
      details: "done",
      artifacts: {},
      blocking_issues: [],
      pending_actions: [],
      subtasks: [],
    };
    const events = [
      {
        type: "item.updated",
        item: {
          id: "reason_1",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Inspecting the task. " }],
        },
      },
      { type: "agent_reasoning_delta", delta: "Checking command output." },
      { type: "agent_reasoning_raw_content_delta", delta: "hidden raw chain-of-thought" },
      {
        type: "item.started",
        item: {
          id: "cmd_1",
          type: "command_execution",
          command: "pwd",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "cmd_1",
          type: "command_execution",
          command: "pwd",
          aggregated_output: "/repo\n",
          exit_code: 0,
        },
      },
      { type: "item.completed", item: { id: "item_msg", type: "agent_message", text: JSON.stringify(structured) } },
    ];
    writeFileSync(fakeCodex, `#!/bin/sh
${events.map((event) => `printf '%s\\n' '${JSON.stringify(event)}'`).join("\n")}
exit 0
`);
    chmodSync(fakeCodex, 0o755);
    process.env.PATH = `${dir}:${originalPath || ""}`;
    try {
      const result = await generateCliResponse("system", {
        model: { sdk: "codex", model: "fake" },
        messages: [{ role: "user", content: "do work" }],
        cwd: process.cwd(),
      });
      expect(result.error).toBeNull();
      expect(result.events).toEqual([
        {
          type: "assistant",
          message: { content: [{ type: "thinking", text: "Inspecting the task." }] },
        },
        {
          type: "assistant",
          message: { content: [{ type: "thinking", text: "Checking command output." }] },
        },
        expect.objectContaining({
          type: "assistant",
          message: {
            content: [expect.objectContaining({ type: "tool_use", id: "cmd_1", name: "command_execution" })],
          },
        }),
        expect.objectContaining({
          type: "user",
          message: {
            content: [expect.objectContaining({ type: "tool_result", tool_use_id: "cmd_1", is_error: false })],
          },
        }),
        expect.objectContaining({ type: "worklab_result_candidate", worklab_result: expect.objectContaining(structured) }),
      ]);
      expect(result.text).toBe("ok\n\ndone");
      expect(result.text).not.toContain("Inspecting the task");
      expect(result.text).not.toContain("hidden raw");
    } finally {
      process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the latest Codex structured progress message as the final worklab result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worklab-fake-cli-"));
    const fakeCodex = join(dir, "codex");
    const originalPath = process.env.PATH;
    const early = {
      schema: "worklab.v2",
      stage: "execute",
      decision: "advance",
      summary: "early progress",
      details: "",
      artifacts: {},
      blocking_issues: [],
      pending_actions: ["finish"],
      subtasks: [],
    };
    const late = {
      ...early,
      summary: "final summary",
      details: "final details",
      pending_actions: [],
    };
    const events = [
      { type: "item.completed", item: { id: "msg_1", type: "agent_message", text: JSON.stringify(early) } },
      { type: "item.completed", item: { id: "msg_2", type: "agent_message", text: JSON.stringify(late) } },
    ];
    writeFileSync(fakeCodex, `#!/bin/sh
${events.map((event) => `printf '%s\\n' '${JSON.stringify(event)}'`).join("\n")}
exit 0
`);
    chmodSync(fakeCodex, 0o755);
    process.env.PATH = `${dir}:${originalPath || ""}`;
    try {
      const result = await generateCliResponse("system", {
        model: { sdk: "codex", model: "fake" },
        messages: [{ role: "user", content: "do work" }],
        cwd: process.cwd(),
      });
      expect(result.error).toBeNull();
      expect(result.worklabResult).toMatchObject(late);
      expect(result.structuredResultSource).toBe("agent_message");
      expect(result.text).toBe("final summary\n\nfinal details");
      expect(result.text).not.toContain("\"schema\"");
      expect(result.events).toEqual([
        expect.objectContaining({ type: "worklab_result_candidate", worklab_result: expect.objectContaining(early) }),
        expect.objectContaining({ type: "worklab_result_candidate", worklab_result: expect.objectContaining(late) }),
      ]);
    } finally {
      process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses structured final_text as the final comment when Codex returns no prose", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worklab-fake-cli-"));
    const fakeCodex = join(dir, "codex");
    const originalPath = process.env.PATH;
    const structured = {
      schema: "worklab.v2",
      stage: "execute",
      decision: "advance",
      summary: "metadata summary",
      details: "technical justification for Worklab",
      final_text: "Human-facing final comment.",
      artifacts: {},
      blocking_issues: [],
      pending_actions: [],
      questions: [],
      subtasks: [],
    };
    const events = [
      { type: "item.completed", item: { id: "msg_1", type: "agent_message", text: JSON.stringify(structured) } },
    ];
    writeFileSync(fakeCodex, `#!/bin/sh
${events.map((event) => `printf '%s\\n' '${JSON.stringify(event)}'`).join("\n")}
exit 0
`);
    chmodSync(fakeCodex, 0o755);
    process.env.PATH = `${dir}:${originalPath || ""}`;
    try {
      const result = await generateCliResponse("system", {
        model: { sdk: "codex", model: "fake" },
        messages: [{ role: "user", content: "do work" }],
        cwd: process.cwd(),
      });
      expect(result.error).toBeNull();
      expect(result.worklabResult).toEqual(structured);
      expect(result.structuredResultSource).toBe("agent_message");
      expect(result.text).toBe("Human-facing final comment.");
      expect(result.text).not.toContain("technical justification");
      expect(result.text).not.toContain("metadata summary");
    } finally {
      process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses delivered Codex prose as final text while extracting embedded worklab JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worklab-fake-cli-"));
    const fakeCodex = join(dir, "codex");
    const originalPath = process.env.PATH;
    const structured = {
      schema: "worklab.v2",
      stage: "execute",
      decision: "advance",
      summary: "short metadata",
      details: "metadata details",
      artifacts: {},
      blocking_issues: [],
      pending_actions: [],
      subtasks: [],
    };
    const delivered = [
      "# Delivered Report",
      "",
      "Useful final answer.",
      "",
      "```json",
      JSON.stringify(structured),
      "```",
    ].join("\n");
    const events = [
      { type: "item.completed", item: { id: "msg_1", type: "agent_message", text: "I will gather data." } },
      { type: "item.completed", item: { id: "msg_2", type: "agent_message", text: delivered } },
    ];
    writeFileSync(fakeCodex, `#!/bin/sh
${events.map((event) => `printf '%s\\n' '${JSON.stringify(event)}'`).join("\n")}
exit 0
`);
    chmodSync(fakeCodex, 0o755);
    process.env.PATH = `${dir}:${originalPath || ""}`;
    try {
      const result = await generateCliResponse("system", {
        model: { sdk: "codex", model: "fake" },
        messages: [{ role: "user", content: "do work" }],
        cwd: process.cwd(),
      });
      expect(result.error).toBeNull();
      expect(result.worklabResult).toMatchObject(structured);
      expect(result.text).toBe("# Delivered Report\n\nUseful final answer.");
      expect(result.text).not.toContain("\"schema\"");
    } finally {
      process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
