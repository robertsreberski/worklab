import { describe, expect, it } from "vitest";
import { normalizeWorklabResult, parseWorklabResultFromText, synthesizeWorklabResult } from "../../core/worklab-result.js";

describe("worklab_result contract", () => {
  it("validates a complete result with subtasks", () => {
    const parsed = normalizeWorklabResult({
      schema: "worklab.v2",
      stage: "execute",
      decision: "delegate",
      summary: "split",
      details: "details",
      artifacts: { patch: "path" },
      blocking_issues: [],
      pending_actions: [],
      subtasks: [{ title: "child", instructions: "do it", suggested_agent: "helper", required: true }],
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.result.subtasks[0]).toMatchObject({ title: "child", required: true });
  });

  it("rejects missing schema or unknown decisions", () => {
    expect(normalizeWorklabResult({ decision: "advance", summary: "x" }).ok).toBe(false);
    expect(normalizeWorklabResult({ schema: "worklab.v2", decision: "maybe", summary: "x" }).ok).toBe(false);
  });

  it("parses direct JSON and fenced JSON", () => {
    const direct = parseWorklabResultFromText(JSON.stringify({ schema: "worklab.v2", decision: "advance", summary: "ok" }));
    expect(direct.ok).toBe(true);
    const fenced = parseWorklabResultFromText("```json\n{\"schema\":\"worklab.v2\",\"decision\":\"pause\",\"summary\":\"need input\"}\n```");
    expect(fenced.ok).toBe(true);
    expect(fenced.result.decision).toBe("pause");
  });

  it("synthesizes the default empty arrays and artifact object", () => {
    const result = synthesizeWorklabResult({ stage: "review", decision: "approve", summary: "ok" });
    expect(result).toMatchObject({
      schema: "worklab.v2",
      stage: "review",
      decision: "approve",
      artifacts: {},
      blocking_issues: [],
      pending_actions: [],
      subtasks: [],
    });
  });
});
