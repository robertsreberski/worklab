import { describe, it, expect } from "vitest";
import {
  RUN_STATUSES,
  EVENT_KINDS,
  RunResultInvalid,
  validateRunResult,
  normalizeUsage,
  makeMcpInitFailedWarning,
  makeRuntimeWarning,
} from "../../core/agent-contract.js";

const validResult = {
  schema: "worklab.v2",
  stage: "execute",
  decision: "advance",
  summary: "ok",
  details: "",
  final_text: "",
  artifacts: {},
  blocking_issues: [],
  pending_actions: [],
  subtasks: [],
};

describe("agent-contract enums", () => {
  it("exposes the documented run statuses", () => {
    expect(RUN_STATUSES).toEqual(["running", "succeeded", "failed", "cancelled", "abandoned"]);
  });

  it("includes runtime_warning + final + done event kinds", () => {
    expect(EVENT_KINDS).toEqual(expect.arrayContaining(["runtime_warning", "final", "done", "verdict"]));
  });
});

describe("validateRunResult", () => {
  it("returns the normalized worklab_result on success", () => {
    const out = validateRunResult({ worklab_result: validResult, usage: null, warnings: [] });
    expect(out.schema).toBe("worklab.v2");
    expect(out.decision).toBe("advance");
  });

  it("rejects missing worklab_result", () => {
    expect(() => validateRunResult({})).toThrow(RunResultInvalid);
  });

  it("rejects pending_actions on advance", () => {
    expect(() => validateRunResult({
      worklab_result: { ...validResult, pending_actions: ["do this"] },
    })).toThrow(/pending_actions/);
  });

  it("rejects malformed warnings", () => {
    expect(() => validateRunResult({
      worklab_result: validResult,
      warnings: [{ message: 42 }],
    })).toThrow(/warnings\[0\].message/);
  });

  it("rejects malformed usage", () => {
    expect(() => validateRunResult({
      worklab_result: validResult,
      usage: { inputTokens: "lots" },
    })).toThrow(/usage\.inputTokens/);
  });

  it("accepts warnings with kind/source/message strings", () => {
    expect(() => validateRunResult({
      worklab_result: validResult,
      warnings: [{ kind: "mcp_init_failed", source: "mcp_init", message: "x" }],
    })).not.toThrow();
  });
});

describe("normalizeUsage", () => {
  it("maps Claude SDK shape", () => {
    const out = normalizeUsage(
      { input_tokens: 100, output_tokens: 50, cache_read_tokens: 10, cache_creation_tokens: 5 },
      "claude",
    );
    expect(out).toMatchObject({
      provider: "claude",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
    });
    expect(out.totalTokens).toBe(165);
  });

  it("maps OpenAI shape", () => {
    const out = normalizeUsage(
      { inputTokens: 200, outputTokens: 80 },
      "openai",
    );
    expect(out.inputTokens).toBe(200);
    expect(out.outputTokens).toBe(80);
    expect(out.totalTokens).toBe(280);
  });

  it("returns nulls for missing values", () => {
    const out = normalizeUsage({}, "vercel");
    expect(out.inputTokens).toBeNull();
    expect(out.outputTokens).toBeNull();
    expect(out.totalTokens).toBeNull();
  });

  it("preserves an explicit total when present", () => {
    const out = normalizeUsage({ inputTokens: 1, outputTokens: 1, total_tokens: 999 }, "claude");
    expect(out.totalTokens).toBe(999);
  });
});

describe("warning factories", () => {
  it("formats mcp_init failure warnings", () => {
    const w = makeMcpInitFailedWarning({ server: "linear", message: "ECONNREFUSED" });
    expect(w.type).toBe("runtime_warning");
    expect(w.warning_kind).toBe("mcp_init_failed");
    expect(w.source).toBe("mcp_init");
    expect(w.message).toContain("linear");
    expect(w.message).toContain("ECONNREFUSED");
  });

  it("makeRuntimeWarning preserves kind/source", () => {
    const w = makeRuntimeWarning({ kind: "stall", source: "worker", message: "no events for 120s" });
    expect(w.warning_kind).toBe("stall");
    expect(w.source).toBe("worker");
    expect(w.message).toBe("no events for 120s");
  });
});
