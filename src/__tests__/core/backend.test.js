import { describe, it, expect } from "vitest";
import { backendCapabilities, backendUsesExecenvConfig, backendSupportsSessionResume, BACKEND_CAPABILITIES } from "../../core/backend.js";

describe("backendCapabilities", () => {
  it("resolves by sdk kind", () => {
    expect(backendCapabilities("claude")).toMatchObject({ kind: "claude", runtime: "sdk" });
    expect(backendCapabilities("claude-code")).toMatchObject({ kind: "claude-code", runtime: "cli", native_runtime_config: "CLAUDE.md" });
    expect(backendCapabilities("codex")).toMatchObject({ kind: "codex", native_runtime_config: "AGENTS.md" });
  });

  it("resolves by model reference string", () => {
    expect(backendCapabilities("claude:claude-opus-4-7").kind).toBe("claude");
    expect(backendCapabilities("codex:gpt-5.5").kind).toBe("codex");
  });

  it("resolves by parsed model object", () => {
    expect(backendCapabilities({ sdk: "openai", model: "gpt-5.5" }).kind).toBe("openai");
  });

  it("throws on unknown sdk", () => {
    expect(() => backendCapabilities("nope")).toThrow();
  });
});

describe("backendUsesExecenvConfig", () => {
  it("only CLI backends have a native runtime config", () => {
    expect(backendUsesExecenvConfig("claude-code")).toBe(true);
    expect(backendUsesExecenvConfig("codex")).toBe(true);
    expect(backendUsesExecenvConfig("claude")).toBe(false);
    expect(backendUsesExecenvConfig("openai")).toBe(false);
    expect(backendUsesExecenvConfig("vercel")).toBe(false);
  });
});

describe("backendSupportsSessionResume", () => {
  it("only Claude Code CLI claims session resume today", () => {
    expect(backendSupportsSessionResume("claude-code")).toBe(true);
    expect(backendSupportsSessionResume("claude")).toBe(false);
    expect(backendSupportsSessionResume("codex")).toBe(false);
  });
});

describe("BACKEND_CAPABILITIES", () => {
  it("covers every PROVIDER_KIND", () => {
    expect(Object.keys(BACKEND_CAPABILITIES).sort()).toEqual(
      ["claude", "claude-code", "codex", "openai", "vercel"],
    );
  });
});
