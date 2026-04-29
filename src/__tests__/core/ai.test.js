import { describe, it, expect } from "vitest";
import { getModels as getPiModels } from "@mariozechner/pi-ai";
import {
  getBuiltinModelByReference,
  getBuiltinModelGroups,
  getBuiltinModels,
  isValidModelReference,
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

  it("parses an exact OpenAI model reference", () => {
    expect(resolveModel("openai:gpt-5.5")).toMatchObject({
      sdk: "openai",
      model: "gpt-5.5",
    });
  });

  it("parses a Vercel custom provider reference preserving colons in model name", () => {
    expect(parseModelReference("vercel:p1:gemma3:4b")).toMatchObject({
      sdk: "vercel",
      providerId: "p1",
      modelName: "gemma3:4b",
      model: "gemma3:4b",
    });
  });

  it("rejects bare tier strings", () => {
    expect(() => parseModelReference("sonnet")).toThrow(/invalid model reference/i);
    expect(isValidModelReference("opus")).toBe(false);
  });

  it("rejects tier-looking prefixed values", () => {
    expect(() => parseModelReference("claude:sonnet")).toThrow(/tier aliases/i);
    expect(() => parseModelReference("openai:opus")).toThrow(/tier aliases/i);
  });

  it("rejects unknown sdk prefix", () => {
    expect(() => parseModelReference("bogus:x")).toThrow(/unknown sdk/i);
  });

  it("rejects malformed Vercel references", () => {
    expect(isValidModelReference("vercel:")).toBe(false);
    expect(isValidModelReference("vercel::model")).toBe(false);
    expect(isValidModelReference("vercel:p1:")).toBe(false);
  });

  it("advertises pi-agent tool, skill, and MCP support accurately", () => {
    const claudeCode = getBuiltinModelByReference("claude-code:claude-sonnet-4-6");
    const codex = getBuiltinModelByReference("codex:gpt-5.5");

    expect(claudeCode).toMatchObject({
      sdk: "claude-code",
      supports_builtin_tools: true,
      capabilities: {
        supports_mcp: true,
        supports_skills: true,
        supports_worklab_tools: true,
        mcp_mode: "sdk",
        skills_mode: "prompt-index",
      },
    });
    expect(claudeCode.builtin_tools).toEqual(expect.arrayContaining(["Read", "Write", "Edit", "Bash"]));

    expect(codex).toMatchObject({
      sdk: "codex",
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
  });

  it("advertises the current pi-ai OpenAI and Codex catalogues", () => {
    const groups = getBuiltinModelGroups();
    const openaiValues = groups.find((group) => group.id === "openai")?.models.map((model) => model.value);
    const codexValues = groups.find((group) => group.id === "codex")?.models.map((model) => model.value);

    expect(openaiValues).toEqual(getPiModels("openai").map((model) => `openai:${model.id}`));
    expect(codexValues).toEqual(getPiModels("openai-codex").map((model) => `codex:${model.id}`));
    expect(getBuiltinModels().map((model) => model.value)).toContain("codex:gpt-5.5");
  });

  it("advertises per-model reasoning effort levels", () => {
    expect(getBuiltinModelByReference("openai:gpt-5.5").capabilities.reasoning_levels).toEqual(["none", "low", "medium", "high", "xhigh"]);
    expect(getBuiltinModelByReference("openai:gpt-5.4-nano").capabilities.reasoning_levels).toEqual(["none", "low", "medium", "high", "xhigh"]);
    expect(getBuiltinModelByReference("claude:claude-sonnet-4-6").capabilities.reasoning_levels).toEqual(["low", "medium", "high", "max"]);
    expect(getBuiltinModelByReference("claude:claude-opus-4-7").capabilities.reasoning_levels).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("normalizes stale or unsupported effort to supported values", () => {
    expect(normalizeReasoningEffortForModel("openai:gpt-5.5", "max")).toBe("xhigh");
    expect(normalizeReasoningEffortForModel("claude:claude-sonnet-4-6", "max")).toBe("max");
    expect(normalizeReasoningEffortForModel("claude:claude-sonnet-4-6", "xhigh")).toBe("high");
    expect(normalizeReasoningEffortForModel("claude:claude-opus-4-7", "max")).toBe("max");
    expect(normalizeReasoningEffortForModel("openai:gpt-5.5", "none")).toBe("none");
  });
});
