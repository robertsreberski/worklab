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
      "--config", "model_reasoning_effort=high",
      "do work",
    ]));
  });
});
