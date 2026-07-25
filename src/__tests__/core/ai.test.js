import { describe, it, expect } from "vitest";
import { getPiModels } from "../../core/pi-model-catalog.js";
import {
  getBuiltinModelByReference,
  getBuiltinModelGroups,
  getBuiltinModels,
  canonicalizeLegacyModelReference,
  isValidModelReference,
  normalizeModelReference,
  normalizeReasoningEffortForModel,
  parseModelReference,
  resolveModel,
} from "../../core/ai.js";

describe("explicit model references", () => {
  it("parses an exact Claude model reference", () => {
    expect(parseModelReference("claude:claude-sonnet-4-6")).toEqual({
      sdk: "claude",
      model: "claude-sonnet-4-6",
      reference: "claude:claude-sonnet-4-6",
    });
  });

  it("parses an exact Pi OpenAI model reference", () => {
    expect(resolveModel("pi:openai:gpt-5.5")).toMatchObject({
      sdk: "pi",
      provider: "openai",
      model: "gpt-5.5",
    });
  });

  it("parses a Pi custom provider reference preserving colons in model name", () => {
    expect(parseModelReference("pi:p1:gemma3:4b")).toMatchObject({
      sdk: "pi",
      provider: "p1",
      model: "gemma3:4b",
    });
  });

  it("rejects bare tier strings", () => {
    expect(() => parseModelReference("sonnet")).toThrow(/invalid model reference/i);
    expect(isValidModelReference("opus")).toBe(false);
  });

  it("rejects tier-looking prefixed values", () => {
    expect(() => parseModelReference("claude:sonnet")).toThrow(/tier aliases/i);
    expect(() => parseModelReference("openai:opus")).toThrow(/reserved runtime/i);
  });

  it("rejects unknown sdk prefix", () => {
    expect(() => parseModelReference("bogus:x")).toThrow(/unknown sdk/i);
  });

  it("rejects malformed Pi references", () => {
    expect(isValidModelReference("pi:")).toBe(false);
    expect(isValidModelReference("pi::model")).toBe(false);
    expect(isValidModelReference("pi:p1:")).toBe(false);
  });

  it("canonicalizes legacy runtime aliases for migration only", () => {
    expect(canonicalizeLegacyModelReference("openai:gpt-5.5")).toBe("pi:openai:gpt-5.5");
    expect(canonicalizeLegacyModelReference("codex:gpt-5.5")).toBe("codex:gpt-5.5");
    expect(canonicalizeLegacyModelReference("vercel:p1:gemma3:4b")).toBe("pi:p1:gemma3:4b");
    expect(canonicalizeLegacyModelReference("claude-code:claude-sonnet-4-6")).toBe("claude:claude-sonnet-4-6");
    expect(canonicalizeLegacyModelReference("pi:openai:gpt-5.5")).toBe("pi:openai:gpt-5.5");
  });

  it("normalizes codex model references as first-class CLI runtime refs", () => {
    expect(normalizeModelReference("codex:gpt-5.5")).toMatchObject({
      sdk: "codex",
      model: "gpt-5.5",
      reference: "codex:gpt-5.5",
    });
  });

  it("reserves old runtime aliases except codex which is active", () => {
    expect(() => parseModelReference("openai:gpt-5.5")).toThrow(/reserved runtime/i);
    expect(parseModelReference("codex:gpt-5.5")).toMatchObject({ sdk: "codex", model: "gpt-5.5" });
    expect(() => parseModelReference("vercel:p1:gemma3:4b")).toThrow(/reserved runtime/i);
    expect(() => parseModelReference("claude-code:claude-sonnet-4-6")).toThrow(/reserved runtime/i);
  });

  it("advertises pi-agent and codex CLI tool, skill, and MCP support accurately", () => {
    const claude = getBuiltinModelByReference("claude:claude-sonnet-4-6");
    const codex = getBuiltinModelByReference("pi:openai-codex:gpt-5.5");
    const codexCli = getBuiltinModelByReference("codex:gpt-5.5");

    expect(claude).toMatchObject({
      sdk: "claude",
      supports_builtin_tools: true,
      capabilities: {
        supports_mcp: true,
        supports_skills: true,
        supports_worklab_tools: true,
        mcp_mode: "sdk",
        skills_mode: "prompt-index",
      },
    });
    expect(claude.builtin_tools).toEqual(expect.arrayContaining(["Read", "Write", "Edit", "Bash"]));

    expect(codex).toMatchObject({
      sdk: "pi",
      provider: "openai-codex",
      supports_builtin_tools: true,
      capabilities: {
        supports_mcp: true,
        supports_skills: true,
        supports_worklab_tools: true,
        mcp_mode: "sdk",
        skills_mode: "read-skill-tool",
      },
    });
    expect(codex.builtin_tools).toEqual(expect.arrayContaining(["Read", "Write", "Edit", "Bash"]));
    expect(codexCli).toMatchObject({
      sdk: "codex",
      model: "gpt-5.5",
      supports_builtin_tools: true,
      capabilities: {
        runtime_kind: "cli",
        mcp_mode: "inline-config",
        skills_mode: "prompt-index",
        supports_fast_mode: true,
        fast_mode_default: true,
      },
    });
  });

  it("advertises the current pi-ai OpenAI and Codex catalogues", () => {
    const groups = getBuiltinModelGroups();
    const openaiValues = groups.find((group) => group.id === "pi:openai")?.models.map((model) => model.value);
    const codexValues = groups.find((group) => group.id === "pi:openai-codex")?.models.map((model) => model.value);
    const codexCliValues = groups.find((group) => group.id === "codex")?.models.map((model) => model.value);

    expect(openaiValues).toEqual(getPiModels("openai").map((model) => `pi:openai:${model.id}`));
    expect(codexValues).toEqual(getPiModels("openai-codex").map((model) => `pi:openai-codex:${model.id}`));
    expect(codexCliValues).toEqual(getPiModels("openai-codex").map((model) => `codex:${model.id}`));
    expect(getBuiltinModels().map((model) => model.value)).toContain("pi:openai-codex:gpt-5.5");
    expect(getBuiltinModels().map((model) => model.value)).toContain("codex:gpt-5.5");
    expect(getBuiltinModels().map((model) => model.value)).toContain("claude:claude-fable-5");
  });

  it("advertises per-model reasoning effort levels", () => {
    expect(getBuiltinModelByReference("pi:openai:gpt-5.5").capabilities.reasoning_levels).toEqual(["none", "low", "medium", "high", "xhigh"]);
    expect(getBuiltinModelByReference("pi:openai:gpt-5.4-nano").capabilities.reasoning_levels).toEqual(["none", "low", "medium", "high", "xhigh"]);
    expect(getBuiltinModelByReference("claude:claude-sonnet-4-6").capabilities.reasoning_levels).toEqual(["low", "medium", "high", "max"]);
    expect(getBuiltinModelByReference("claude:claude-opus-4-7").capabilities.reasoning_levels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(getBuiltinModelByReference("claude:claude-fable-5").capabilities.reasoning_levels).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("normalizes stale or unsupported effort to supported values", () => {
    expect(normalizeReasoningEffortForModel("pi:openai:gpt-5.5", "max")).toBe("xhigh");
    expect(normalizeReasoningEffortForModel("claude:claude-sonnet-4-6", "max")).toBe("max");
    expect(normalizeReasoningEffortForModel("claude:claude-sonnet-4-6", "xhigh")).toBe("high");
    expect(normalizeReasoningEffortForModel("claude:claude-opus-4-7", "max")).toBe("max");
    expect(normalizeReasoningEffortForModel("pi:openai:gpt-5.5", "none")).toBe("none");
  });
});
