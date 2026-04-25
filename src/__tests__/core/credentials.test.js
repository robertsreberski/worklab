import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBuiltinProviderAvailability } from "../../core/credentials.js";

const ENV_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY"];
const dirs = [];

function fakeCliPath() {
  const dir = mkdtempSync(join(tmpdir(), "worklab-credentials-bin-"));
  dirs.push(dir);
  for (const command of ["claude", "codex"]) {
    const path = join(dir, command);
    writeFileSync(path, "#!/bin/sh\nexit 0\n");
    chmodSync(path, 0o755);
  }
  return dir;
}

describe("getBuiltinProviderAvailability", () => {
  const saved = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("reports both providers unavailable when no keys are set", () => {
    const result = getBuiltinProviderAvailability();
    expect(result.claude.available).toBe(false);
    expect(result.openai.available).toBe(false);
    expect(result.claude.reason).toMatch(/ANTHROPIC_API_KEY/);
    expect(result.openai.reason).toMatch(/OPENAI_API_KEY/);
  });

  it("marks claude available when ANTHROPIC_API_KEY is set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    const result = getBuiltinProviderAvailability();
    expect(result.claude.available).toBe(true);
    expect(result.claude.reason).toBe(null);
  });

  it("marks claude available when CLAUDE_CODE_OAUTH_TOKEN is set", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-token";
    const result = getBuiltinProviderAvailability();
    expect(result.claude.available).toBe(true);
  });

  it("marks claude available when ANTHROPIC_AUTH_TOKEN is set", () => {
    process.env.ANTHROPIC_AUTH_TOKEN = "auth-token";
    const result = getBuiltinProviderAvailability();
    expect(result.claude.available).toBe(true);
  });

  it("marks openai available when OPENAI_API_KEY is set", () => {
    process.env.OPENAI_API_KEY = "sk-openai";
    const result = getBuiltinProviderAvailability();
    expect(result.openai.available).toBe(true);
    expect(result.openai.reason).toBe(null);
  });

  it("returns independent results per provider", () => {
    process.env.OPENAI_API_KEY = "sk-openai";
    const result = getBuiltinProviderAvailability();
    expect(result.openai.available).toBe(true);
    expect(result.claude.available).toBe(false);
  });

  it("reports local CLI versions and env-backed CLI auth", () => {
    const execImpl = vi.fn((command, args) => {
      if (command === "claude" && args[0] === "--version") return "2.1.0 (Claude Code)\n";
      if (command === "codex" && args[0] === "--version") return "codex-cli 0.125.0\n";
      throw new Error(`unexpected probe: ${command} ${args.join(" ")}`);
    });
    const result = getBuiltinProviderAvailability({
      env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth", CODEX_API_KEY: "codex", PATH: fakeCliPath() },
      execImpl,
    });
    expect(result["claude-code"]).toMatchObject({ available: true, command_available: true, version: "2.1.0 (Claude Code)" });
    expect(result.codex).toMatchObject({ available: true, command_available: true, version: "codex-cli 0.125.0" });
  });

  it("requires CLI authentication when only the command is installed", () => {
    const execImpl = vi.fn((command, args) => {
      if (args[0] === "--version") return `${command} version\n`;
      throw Object.assign(new Error("not logged in"), { stderr: "not logged in" });
    });
    const result = getBuiltinProviderAvailability({
      env: { PATH: fakeCliPath() },
      execImpl,
    });
    expect(result["claude-code"].available).toBe(false);
    expect(result["claude-code"].reason).toMatch(/claude auth login/i);
    expect(result.codex.available).toBe(false);
    expect(result.codex.reason).toMatch(/codex login/i);
  });
});
