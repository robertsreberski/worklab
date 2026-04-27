import { describe, expect, it } from "vitest";
import {
  schemaPropertyRows,
  splitStructuredText,
  structuredErrorValue,
  structuredKind,
  structuredPreview,
} from "../../ui/src/lib/structuredValue.js";

describe("structured value parsing", () => {
  it("detects worklab results and summarizes them", () => {
    const result = {
      schema: "worklab.v2",
      stage: "review",
      decision: "approve",
      summary: "Approved",
      details: "Looks good.",
    };

    expect(structuredKind(result)).toBe("worklab");
    expect(structuredPreview(result)).toBe("Approved");
  });

  it("detects strict JSON schema properties", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["schema", "summary"],
      properties: {
        schema: { type: "string", enum: ["worklab.v2"] },
        summary: { type: "string" },
      },
    };

    expect(structuredKind(schema)).toBe("schema");
    expect(structuredPreview(schema)).toBe("JSON Schema: object, 2 properties");
    expect(schemaPropertyRows(schema)).toEqual([
      { name: "schema", type: "string", required: true, enum: "worklab.v2" },
      { name: "summary", type: "string", required: true, enum: "" },
    ]);
  });

  it("detects provider errors", () => {
    const error = {
      type: "error",
      error: {
        code: "invalid_json_schema",
        message: "Invalid schema",
        param: "text.format.schema",
      },
      status: 400,
    };

    expect(structuredKind(error)).toBe("error");
    expect(structuredPreview(error)).toBe("invalid_json_schema · text.format.schema · Invalid schema");
  });

  it("does not treat successful status objects as errors", () => {
    const payload = { status: "completed", changes: [{ path: "/tmp/a.js", kind: "update" }] };

    expect(structuredKind(payload)).toBe("object");
    expect(structuredPreview(payload)).toBe("2 fields");
  });

  it("unwraps serialized provider errors embedded in CLI event messages", () => {
    const providerError = {
      type: "error",
      error: {
        type: "invalid_request_error",
        code: "invalid_json_schema",
        message: "Invalid schema",
        param: "text.format.schema",
      },
      status: 400,
    };
    const error = {
      type: "turn.failed",
      message: JSON.stringify(providerError),
    };
    const errorField = {
      type: "turn.failed",
      error: JSON.stringify(providerError),
    };

    expect(structuredKind(error)).toBe("error");
    expect(structuredKind(errorField)).toBe("error");
    expect(structuredPreview(error)).toBe("invalid_json_schema · text.format.schema · Invalid schema");
    expect(structuredPreview(errorField)).toBe("invalid_json_schema · text.format.schema · Invalid schema");
    expect(structuredErrorValue(error)).toMatchObject({
      type: "invalid_request_error",
      code: "invalid_json_schema",
      param: "text.format.schema",
      status: 400,
    });
    expect(structuredErrorValue(errorField)).toMatchObject({
      type: "invalid_request_error",
      code: "invalid_json_schema",
      param: "text.format.schema",
      status: 400,
    });
  });

  it("unwraps serialized provider errors embedded in nested error fields", () => {
    const error = {
      type: "turn.failed",
      error: {
        message: JSON.stringify({
          type: "error",
          error: {
            type: "invalid_request_error",
            code: "invalid_json_schema",
            message: "Invalid schema",
            param: "text.format.schema",
          },
          status: 400,
        }),
      },
    };

    expect(structuredKind(error)).toBe("error");
    expect(structuredPreview(error)).toBe("invalid_json_schema · text.format.schema · Invalid schema");
    expect(structuredErrorValue(error)).toMatchObject({
      type: "invalid_request_error",
      code: "invalid_json_schema",
      param: "text.format.schema",
      status: 400,
    });
  });

  it("detects MCP content arrays", () => {
    const payload = { content: [{ type: "text", text: "{\"echo\":\"ok\"}" }] };

    expect(structuredKind(payload)).toBe("content");
    expect(structuredPreview(payload)).toBe("{\"echo\":\"ok\"}");
  });

  it("splits fenced JSON blocks without flattening surrounding prose", () => {
    const segments = splitStructuredText("Before\n\n```json\n{\"type\":\"object\",\"properties\":{\"x\":{\"type\":\"string\"}}}\n```\n\nAfter");

    expect(segments).toEqual([
      { type: "markdown", text: "Before" },
      { type: "structured", value: { type: "object", properties: { x: { type: "string" } } } },
      { type: "markdown", text: "After" },
    ]);
  });

  it("splits legacy ERROR JSON comments into label plus structured payload", () => {
    const segments = splitStructuredText('ERROR: {"error":{"code":"invalid_json_schema","message":"Invalid schema"}}');

    expect(segments).toEqual([
      { type: "markdown", text: "ERROR:" },
      { type: "structured", value: { error: { code: "invalid_json_schema", message: "Invalid schema" } } },
    ]);
  });
});
