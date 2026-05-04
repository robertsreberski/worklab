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

  it("keeps unknown parent review policies for watcher fallback", () => {
    const parsed = normalizeWorklabResult({
      schema: "worklab.v2",
      stage: "plan",
      decision: "delegate",
      summary: "split",
      parent_review_policy: "future_policy",
      subtasks: [{ title: "child", instructions: "do it" }],
    });

    expect(parsed.ok).toBe(true);
    expect(parsed.result.parent_review_policy).toBe("future_policy");
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

  it("recovers Claude SDK structured-output fields embedded as parameter text", () => {
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
            summary: "Delivered UI audit.",
            details: "Scope and findings.</details>\n<parameter name=\"final_text\">Audit complete.</final_text>\n<parameter name=\"artifacts\">{\"kb_slug\":\"ui-audit-activity-workspace\"}</parameter>\n<parameter name=\"blocking_issues\">[]",
            pending_actions: [],
            questions: [],
            subtasks: [],
            parent_review_policy: "default",
          },
        }],
      },
    };

    const parsed = extractWorklabResult(event);

    expect(parsed.ok).toBe(true);
    expect(parsed.result).toMatchObject({
      schema: "worklab.v2",
      stage: "execute",
      decision: "advance",
      summary: "Delivered UI audit.",
      details: "Scope and findings.",
      final_text: "Audit complete.",
      artifacts: { kb_slug: "ui-audit-activity-workspace" },
      blocking_issues: [],
      parent_review_policy: "default",
    });
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

  it("preserves optional memory candidates for structured agent learning", () => {
    const parsed = normalizeWorklabResult({
      schema: "worklab.v2",
      stage: "execute",
      decision: "advance",
      summary: "done",
      details: "",
      memory_candidates: [
        { kind: "procedure", content: "Use focused tests first.", confidence: 0.9 },
      ],
    });

    expect(parsed.ok).toBe(true);
    expect(parsed.result.memory_candidates).toEqual([
      { kind: "procedure", scope: "agent", content: "Use focused tests first.", evidence: "", confidence: 0.9 },
    ]);
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

  it("validates planning questions only for plan-stage pauses", () => {
    const base = {
      schema: "worklab.v2",
      stage: "plan",
      decision: "pause",
      summary: "Need direction",
      details: "",
      artifacts: {},
      blocking_issues: [],
      pending_actions: [],
      subtasks: [],
      questions: [{
        id: "scope",
        header: "Scope",
        question: "Which scope should the planner optimize for?",
        options: [
          { id: "minimal", label: "Minimal", description: "Smallest useful change." },
          { id: "complete", label: "Complete", description: "End-to-end feature." },
        ],
      }],
    };

    expect(normalizeWorklabResult(base).ok).toBe(true);
    expect(validateWorklabResultSemantics(base).ok).toBe(true);
    expect(validateWorklabResultSemantics({ ...base, stage: "execute" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("plan"),
    });
    expect(validateWorklabResultSemantics({ ...base, decision: "advance" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("pause"),
    });
    expect(validateWorklabResultSemantics({ ...base, questions: [] })).toMatchObject({
      ok: false,
      error: expect.stringContaining("pending_action"),
    });
    expect(normalizeWorklabResult({
      ...base,
      questions: [base.questions[0], base.questions[0], base.questions[0], base.questions[0]],
    }).ok).toBe(false);
  });

  it("exports a structured-output schema aligned with runtime defaults", () => {
    for (const objectSchema of collectObjectSchemas(WORKLAB_RESULT_JSON_SCHEMA)) {
      expect(objectSchema.additionalProperties).toBe(false);
    }
    expect(WORKLAB_RESULT_JSON_SCHEMA.required).toEqual(["schema", "stage", "decision", "summary", "details"]);
    expect(WORKLAB_RESULT_JSON_SCHEMA.properties.parent_review_policy).toMatchObject({
      type: ["string", "null"],
    });
    expect(WORKLAB_RESULT_JSON_SCHEMA.properties.memory_candidates.type).toBe("array");
    expect(WORKLAB_RESULT_JSON_SCHEMA.properties.schema).toEqual({
      type: "string",
      enum: ["worklab.v2"],
    });
    expect(WORKLAB_RESULT_JSON_SCHEMA.properties.questions.type).toBe("array");
  });

  it("keeps exported output-schema objects strict while parsing stored artifacts permissively", () => {
    const parsed = normalizeWorklabResult({
      schema: "worklab.v2",
      stage: "execute",
      decision: "advance",
      summary: "ok",
      artifacts: { patch: "path" },
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.result.artifacts).toEqual({ patch: "path" });

    const artifacts = WORKLAB_RESULT_JSON_SCHEMA.properties.artifacts;
    expect(artifacts).toMatchObject({
      type: "object",
      additionalProperties: false,
    });

    const subtask = WORKLAB_RESULT_JSON_SCHEMA.properties.subtasks.items;
    expect(subtask.required).toEqual(Object.keys(subtask.properties));
    expect(subtask.properties.suggested_agent.type).toEqual(["string", "null"]);
    expect(subtask.properties.expected_artifact.type).toEqual(["string", "null"]);
  });

  describe("verification_evidence (Phase 4)", () => {
    it("accepts well-formed evidence rows and defaults to []", () => {
      const empty = normalizeWorklabResult({
        schema: "worklab.v2",
        stage: "review",
        decision: "approve",
        summary: "ok",
      });
      expect(empty.ok).toBe(true);
      expect(empty.result.verification_evidence).toEqual([]);

      const full = normalizeWorklabResult({
        schema: "worklab.v2",
        stage: "review",
        decision: "approve",
        summary: "ok",
        verification_evidence: [
          { kind: "test", command_or_url: "npm test foo", exit_code_or_status: "0", snippet: "OK 7" },
          { kind: "n_a", reason: "documentation only" },
        ],
      });
      expect(full.ok).toBe(true);
      expect(full.result.verification_evidence).toHaveLength(2);
      expect(full.result.verification_evidence[0]).toMatchObject({ kind: "test", command_or_url: "npm test foo" });
      expect(full.result.verification_evidence[1].kind).toBe("n_a");
    });

    it("rejects evidence rows with unrecognised kinds", () => {
      const bad = normalizeWorklabResult({
        schema: "worklab.v2",
        stage: "review",
        decision: "approve",
        summary: "ok",
        verification_evidence: [{ kind: "guess" }],
      });
      expect(bad.ok).toBe(false);
    });

    it("exposes verification_evidence in the JSON schema", () => {
      const ve = WORKLAB_RESULT_JSON_SCHEMA.properties.verification_evidence;
      expect(ve.type).toBe("array");
      expect(ve.items.required).toEqual(["kind", "command_or_url", "exit_code_or_status", "snippet", "reason"]);
      expect(ve.items.properties.kind.enum).toEqual(["test", "build", "lint", "manual_check", "screenshot", "n_a"]);
    });
  });
});
