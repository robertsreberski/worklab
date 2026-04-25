import { describe, expect, it } from "vitest";
import { buildCliCommand } from "../../core/ai-cli.js";
import { parseModelReference } from "../../core/ai.js";

describe("CLI provider adapters", () => {
  it("parses Claude Code and Codex model references", () => {
    expect(parseModelReference("claude-code:claude-sonnet-4-6")).toMatchObject({
      sdk: "claude-code",
      model: "claude-sonnet-4-6",
    });
    expect(parseModelReference("codex:gpt-5.4")).toMatchObject({
      sdk: "codex",
      model: "gpt-5.4",
    });
  });

  it("generates Claude Code stream-json command with schema and system prompt", () => {
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
      "--json-schema", "/tmp/schema.json",
      "--model", "claude-sonnet-4-6",
      "--append-system-prompt", "system",
      "--no-session-persistence",
      "do work",
    ]));
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
    });
    expect(cmd.args).toEqual(expect.arrayContaining([
      "--effort", "high",
      "--permission-mode", "bypassPermissions",
      "--max-turns", "12",
      "--tools", "Read,Bash",
      "--allowedTools", "Read Bash mcp__worklab__*",
      "--disallowedTools", "WebSearch",
      "--mcp-config", "/tmp/mcp.json",
      "--strict-mcp-config",
    ]));
  });

  it("generates Codex exec JSON command with schema, cwd, and effort", () => {
    const cmd = buildCliCommand({
      sdk: "codex",
      model: "gpt-5.4",
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
      "--model", "gpt-5.4",
      "--cd", "/repo",
      "--ephemeral",
      "--skip-git-repo-check",
      "--config", "model_reasoning_effort=high",
      "do work",
    ]));
  });

  it("maps Codex permissions and MCP servers to exec flags/config overrides", () => {
    const cmd = buildCliCommand({
      sdk: "codex",
      model: "gpt-5.4",
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
      "--config", "mcp_servers.worklab.command=\"/bin/sh\"",
      "--config", "mcp_servers.worklab.args=[\"-lc\", \"node server.js\"]",
      "--config", "mcp_servers.worklab.env.WORKLAB_RUN_ID=\"run_1\"",
      "--config", "mcp_servers.worklab.enabled=true",
    ]));
  });
});
