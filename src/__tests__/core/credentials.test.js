import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBuiltinProviderAvailability } from "../../core/credentials.js";

const ENV_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_CODEX_API_KEY"];
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
    expect(result["pi:openai"].available).toBe(false);
    expect(result["pi:openai-codex"].available).toBe(false);
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
    expect(result["pi:openai"].available).toBe(true);
    expect(result.openai.reason).toBe(null);
  });

  it("returns independent results per provider", () => {
    process.env.OPENAI_API_KEY = "sk-openai";
    const result = getBuiltinProviderAvailability();
    expect(result.openai.available).toBe(true);
    expect(result.claude.available).toBe(false);
  });

  it("reports Pi Codex auth and active Codex CLI readiness independently", () => {
    const result = getBuiltinProviderAvailability({
      env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth", CODEX_API_KEY: "codex", PATH: fakeCliPath() },
      execImpl: vi.fn(() => ""),
    });
    expect(result["pi:openai-codex"]).toMatchObject({ available: true, runtime_kind: "pi-agent", auth: "codex_api_key" });
    expect(result.codex).toMatchObject({ available: true, runtime_kind: "cli", auth: "codex-cli" });
    expect(result).not.toHaveProperty("claude-code");
  });

  it("marks pi Codex unavailable without env or pi OAuth credentials", () => {
    const execImpl = vi.fn((command, args) => {
      if (args[0] === "--version") return `${command} version\n`;
      throw Object.assign(new Error("not logged in"), { stderr: "not logged in" });
    });
    const result = getBuiltinProviderAvailability({
      env: { PATH: fakeCliPath() },
      execImpl,
    });
    expect(result["pi:openai-codex"].available).toBe(false);
    expect(result["pi:openai-codex"].reason).toMatch(/OPENAI_CODEX_API_KEY/i);
    expect(result.codex).toMatchObject({ available: true, runtime_kind: "cli", auth: "codex-cli" });
  });

  it("marks Pi Codex available from pi OAuth credentials", () => {
    const dir = mkdtempSync(join(tmpdir(), "worklab-pi-auth-"));
    dirs.push(dir);
    writeFileSync(join(dir, "pi-auth.json"), JSON.stringify({
      "openai-codex": { access: "token", refresh: "refresh", expires: Date.now() + 60_000 },
    }));
    const result = getBuiltinProviderAvailability({ env: { PATH: "" }, dataDir: dir });
    expect(result["pi:openai-codex"]).toMatchObject({ available: true, runtime_kind: "pi-agent", auth: "pi-oauth" });
  });
});
