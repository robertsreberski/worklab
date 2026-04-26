import { describe, expect, it } from "vitest";
import {
  WORKLAB_RESULT_JSON_SCHEMA,
  extractWorklabResult,
  normalizeWorklabResult,
  parseWorklabResultFromText,
  synthesizeWorklabResult,
} from "../../core/worklab-result.js";

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
