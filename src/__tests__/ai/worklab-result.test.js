import { describe, expect, it } from "vitest";
import {
  WORKLAB_RESULT_JSON_SCHEMA,
  extractWorklabResult,
  formatWorklabResultText,
  normalizeWorklabResult,
  parseWorklabResultFromText,
  synthesizeWorklabResult,
  validateWorklabResultSemantics,
} from "../../ai/result/contract.js";

function collectObjectSchemas(schema) {
  const found = [];
  function visit(node) {
    if (!node || typeof node !== "object") return;
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (types.includes("object")) found.push(node);
    for (const property of Object.values(node.properties || {})) visit(property);
    if (node.items) visit(node.items);
    for (const option of node.anyOf || []) visit(option);
  }
  visit(schema);
  return found;
}

describe("worklab_result contract", () => {
  it("validates a complete result with subtasks", () => {
    const parsed = normalizeWorklabResult({
      schema: "worklab.v2",
      stage: "execute",
      decision: "delegate",
      summary: "split",
      details: "details",
      final_text: "Final comment.",
      artifacts: { patch: "path" },
      blocking_issues: [],
      pending_actions: [],
      subtasks: [{ title: "child", instructions: "do it", suggested_agent: "helper", required: true }],
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.result.subtasks[0]).toMatchObject({ title: "child", required: true });
    expect(parsed.result.final_text).toBe("Final comment.");
  });

  it("normalizes string subtask acceptance criteria into an array", () => {
    const text = JSON.stringify({
      schema: "worklab.v2",
      stage: "plan",
      decision: "delegate",
      summary: "split",
      details: "delegate the work",
      artifacts: {},
      blocking_issues: [],
      pending_actions: [],
      subtasks: [{
        title: "child",
        instructions: "do it",
        suggested_agent: "helper",
        required: true,
        acceptance_criteria: "Provide a short report.",
        expected_artifact: "Report",
      }],
    });

    const parsed = parseWorklabResultFromText(text);

    expect(parsed.ok).toBe(true);
    expect(parsed.result.subtasks[0].acceptance_criteria).toEqual(["Provide a short report."]);
  });

  it("uses final_text for human-facing result text with legacy summary/details fallback", () => {
    const normalized = normalizeWorklabResult({
      schema: "worklab.v2",
      stage: "execute",
      decision: "advance",
      summary: "metadata summary",
      details: "technical detail",
      final_text: "Human-facing final comment.",
    });

    expect(normalized.ok).toBe(true);
    expect(formatWorklabResultText(normalized.result)).toBe("Human-facing final comment.");

    const legacy = normalizeWorklabResult({
      schema: "worklab.v2",
      stage: "execute",
      decision: "advance",
      summary: "legacy summary",
      details: "legacy detail",
    });

    expect(legacy.ok).toBe(true);
    expect(legacy.result.final_text).toBe("");
    expect(formatWorklabResultText(legacy.result)).toBe("legacy summary\n\nlegacy detail");
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

  it("recovers unambiguous malformed review approvals with unescaped quotes in final_text", () => {
    const malformed = `\`\`\`json
{
  "schema": "worklab.v2",
  "stage": "review",
  "decision": "approve",
  "summary": "Review passed.",
  "details": "Verified the owner output.",
  "final_text": "Approve. The UI shows "Reveal archived history" and "default V1 path" correctly.",
  "artifacts": {},
  "blocking_issues": [],
  "pending_actions": [],
  "subtasks": []
}
\`\`\``;

    const parsed = parseWorklabResultFromText(malformed, { stage: "review" });

    expect(parsed.ok).toBe(true);
    expect(parsed.worklabCandidate).toBe(true);
    expect(parsed.result).toMatchObject({
      schema: "worklab.v2",
      stage: "review",
      decision: "approve",
      summary: "Review passed.",
      details: "Verified the owner output.",
      pending_actions: [],
      subtasks: [],
    });
    expect(parsed.result.final_text).toContain('"Reveal archived history"');
  });

  it("treats malformed non-review worklab JSON as a candidate instead of prose fallback", () => {
    const malformed = `\`\`\`json
{
  "schema": "worklab.v2",
  "stage": "execute",
  "decision": "advance",
  "summary": "Done.",
  "details": "Details mention "quoted text" without escaping.",
  "final_text": "Done.",
  "artifacts": {},
  "blocking_issues": [],
  "pending_actions": [],
  "subtasks": []
}
\`\`\``;

    const parsed = parseWorklabResultFromText(malformed, { stage: "execute" });

    expect(parsed.ok).toBe(false);
    expect(parsed.worklabCandidate).toBe(true);
    expect(parsed.error).toMatch(/malformed/i);
  });

  it("does not recover malformed review JSON when subtasks are present", () => {
    const malformed = `\`\`\`json
{
  "schema": "worklab.v2",
  "stage": "review",
  "decision": "approve",
  "summary": "Review passed.",
  "details": "Details mention "quoted text" without escaping.",
  "final_text": "Approve.",
  "artifacts": {},
  "blocking_issues": [],
  "pending_actions": [],
  "subtasks": [{"title":"child"}]
}
\`\`\``;

    const parsed = parseWorklabResultFromText(malformed, { stage: "review" });

    expect(parsed.ok).toBe(false);
    expect(parsed.worklabCandidate).toBe(true);
    expect(parsed.error).toMatch(/malformed/i);
  });

  it("parses the last worklab result from concatenated progress JSON", () => {
    const first = {
      schema: "worklab.v2",
      stage: "execute",
      decision: "advance",
      summary: "started",
      details: "",
      artifacts: {},
      blocking_issues: [],
      pending_actions: ["finish"],
      subtasks: [],
    };
    const last = {
      ...first,
      summary: "finished",
      details: "final details",
      pending_actions: [],
    };
    const parsed = parseWorklabResultFromText(`${JSON.stringify(first)}\n\n${JSON.stringify(last)}`);
    expect(parsed.ok).toBe(true);
    expect(parsed.result.summary).toBe("finished");
    expect(parsed.result.details).toBe("final details");
  });

  it("extracts a result from Claude StructuredOutput tool events", () => {
    const event = {
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          name: "StructuredOutput",
          input: {
            schema: "worklab.v2",
            stage: "execute",
            decision: "advance",
            summary: "done",
            details: "",
            artifacts: {},
            blocking_issues: [],
            pending_actions: [],
            subtasks: [],
          },
        }],
      },
    };
    const parsed = extractWorklabResult(event);
    expect(parsed.ok).toBe(true);
    expect(parsed.result.summary).toBe("done");
  });

  it("extracts the latest result from Codex agent message item streams", () => {
    const parsed = extractWorklabResult({
      type: "item.completed",
      item: {
        type: "agent_message",
        text: [
          "{\"schema\":\"worklab.v2\",\"stage\":\"execute\",\"decision\":\"advance\",\"summary\":\"early\",\"details\":\"\",\"artifacts\":{},\"blocking_issues\":[],\"pending_actions\":[\"x\"],\"subtasks\":[]}",
          "{\"schema\":\"worklab.v2\",\"stage\":\"execute\",\"decision\":\"advance\",\"summary\":\"late\",\"details\":\"done\",\"artifacts\":{},\"blocking_issues\":[],\"pending_actions\":[],\"subtasks\":[]}",
        ].join("\n\n"),
      },
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.result.summary).toBe("late");
    expect(parsed.result.pending_actions).toEqual([]);
  });

  it("synthesizes the default empty arrays and artifact object", () => {
    const result = synthesizeWorklabResult({ stage: "review", decision: "approve", summary: "ok" });
    expect(result).toMatchObject({
      schema: "worklab.v2",
      stage: "review",
      decision: "approve",
      final_text: "",
      artifacts: {},
      blocking_issues: [],
      pending_actions: [],
      subtasks: [],
    });
  });

  it("validates runtime semantics for pending actions and subtasks", () => {
    const base = {
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

    expect(validateWorklabResultSemantics(base).ok).toBe(true);
    expect(validateWorklabResultSemantics({ ...base, pending_actions: ["approve"] })).toMatchObject({
      ok: false,
      error: expect.stringContaining("pause"),
    });
    expect(validateWorklabResultSemantics({ ...base, subtasks: [{ title: "child" }] })).toMatchObject({
      ok: false,
      error: expect.stringContaining("delegate"),
    });
    expect(validateWorklabResultSemantics({ ...base, decision: "pause", pending_actions: [] })).toMatchObject({
      ok: false,
      error: expect.stringContaining("pending_action"),
    });
    expect(validateWorklabResultSemantics({ ...base, decision: "pause", pending_actions: ["confirm"] }).ok).toBe(true);
    expect(validateWorklabResultSemantics({ ...base, decision: "delegate", subtasks: [{ title: "child" }] }).ok).toBe(true);
  });

  it("exports a strict JSON schema for Codex structured output", () => {
    for (const objectSchema of collectObjectSchemas(WORKLAB_RESULT_JSON_SCHEMA)) {
      expect(objectSchema.additionalProperties).toBe(false);
    }
    expect(WORKLAB_RESULT_JSON_SCHEMA.required).toEqual(Object.keys(WORKLAB_RESULT_JSON_SCHEMA.properties));
    expect(WORKLAB_RESULT_JSON_SCHEMA.properties.schema).toEqual({
      type: "string",
      enum: ["worklab.v2"],
    });
  });

  it("keeps strict artifact and subtask shapes in the exported JSON schema", () => {
    const artifacts = WORKLAB_RESULT_JSON_SCHEMA.properties.artifacts;
    expect(artifacts).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {},
      required: [],
    });

    const subtask = WORKLAB_RESULT_JSON_SCHEMA.properties.subtasks.items;
    expect(subtask.required).toEqual(Object.keys(subtask.properties));
    expect(subtask.properties.suggested_agent.type).toEqual(["string", "null"]);
    expect(subtask.properties.expected_artifact.type).toEqual(["string", "null"]);
  });
});
