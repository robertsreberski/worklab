import { describe, expect, it } from "vitest";
import { normalizeCommentBody, normalizeCommentText, shouldHideComment, stripWorklabJson } from "../../ui/src/lib/commentFormatting.js";

describe("comment display normalization", () => {
  it("renders full worklab_result JSON as readable summary and details", () => {
    const body = JSON.stringify({
      schema: "worklab.v2",
      stage: "review",
      decision: "approve",
      summary: "Approved",
      details: "Looks good.",
      artifacts: {},
      blocking_issues: [],
      pending_actions: [],
      subtasks: [],
    });

    expect(stripWorklabJson(body)).toBe("Approved\n\nLooks good.");
  });

  it("removes fenced worklab_result JSON from prose comments", () => {
    const body = `Verified the file.

\`\`\`json
{"schema":"worklab.v2","stage":"review","decision":"approve","summary":"Approved","details":"Looks good.","artifacts":{},"blocking_issues":[],"pending_actions":[],"subtasks":[]}
\`\`\``;

    expect(stripWorklabJson(body)).toBe("Verified the file.");
  });

  it("formats legacy raw JSON schema errors", () => {
    const body = `ERROR: {"type":"error","error":{"code":"invalid_json_schema","message":"Invalid schema for response_format 'codex_output_schema'","param":"text.format.schema"}}`;

    expect(normalizeCommentBody(body)).toBe("ERROR: Invalid response schema (text.format.schema): Invalid schema for response_format 'codex_output_schema'");
  });

  it("hides standalone approval verdict comments", () => {
    expect(shouldHideComment({ author_type: "system", body: "VERDICT: APPROVE" })).toBe(true);
    expect(shouldHideComment({ author_type: "system", body: "VERDICT: REJECT\n\nFix it" })).toBe(false);
  });

  it("collapses repeated paragraphs in legacy comments", () => {
    expect(normalizeCommentBody("Plan A.\n\nPlan A.")).toBe("Plan A.");
  });

  it("repairs adjacent sentence spacing in legacy generated comments", () => {
    expect(normalizeCommentBody("Checked contents.File exists.")).toBe("Checked contents. File exists.");
  });

  it("preserves structured JSON values before UI parsing", () => {
    const body = 'ERROR: {"error":{"message":"Keep a.B unchanged"}}';
    expect(normalizeCommentText(body)).toBe(body);
  });
});
