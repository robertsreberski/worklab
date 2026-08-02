import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  acpElicitationDecision,
  acpFormInitialValues,
  acpFormResponse,
  acpFormValues,
  acpInteractionEventRequiresRefresh,
  acpInteractionIsStale,
  acpPermissionResponse,
  normalizeAcpInteraction,
  normalizePendingAcpInteractions,
} from "../../ui/src/lib/acpInteractions.js";

describe("ACP interaction UI helpers", () => {
  it("projects permission choices and submits only an exact offered option id", () => {
    const interaction = normalizeAcpInteraction({
      id: "interaction-1",
      kind: "permission",
      state: "pending",
      taskRunId: "run-1",
      requestSchema: {
        sessionId: "session-1",
        toolCall: { title: "Delete generated files", kind: "delete", status: "pending", arguments: { secret: "drop" } },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
          { name: "Missing id" },
        ],
      },
      response: { outcome: { optionId: "persisted-secret-option" } },
    });

    expect(interaction).toMatchObject({
      id: "interaction-1",
      kind: "permission",
      taskRunId: "run-1",
      toolCall: { title: "Delete generated files", kind: "delete", status: "pending" },
      options: [
        { id: "allow-once", label: "Allow once", kind: "allow_once" },
        { id: "reject-once", label: "Reject", kind: "reject_once" },
      ],
    });
    expect(JSON.stringify(interaction)).not.toMatch(/session-1|arguments|persisted-secret-option/u);
    expect(acpPermissionResponse(interaction, "allow-once")).toEqual({
      disposition: "selected",
      outcome: { outcome: "selected", optionId: "allow-once" },
    });
    expect(() => acpPermissionResponse(interaction, "allow_once")).toThrow("offered permission options");
  });

  it("filters and orders only pending canonical interactions", () => {
    const pending = normalizePendingAcpInteractions({ interactions: [
      { id: "later", kind: "url", state: "pending", createdAt: 20, requestSchema: { url: "https://example.test" } },
      { id: "settled", kind: "form", state: "submitted", createdAt: 5, requestSchema: {} },
      { id: "first", kind: "form", state: "pending", created_at: 10, request_schema: { properties: {} } },
      { id: "unknown", kind: "custom", state: "pending", createdAt: 1 },
    ] });

    expect(pending.map((interaction) => interaction.id)).toEqual(["first", "later"]);
  });

  it("collects supported non-secret schema fields without retaining defaults or response values", () => {
    const interaction = normalizeAcpInteraction({
      id: "form-1",
      kind: "form",
      state: "pending",
      requestSchema: {
        mode: "form",
        message: "Tell the agent how to continue.",
        requestedSchema: {
          type: "object",
          properties: {
            summary: { type: "string", title: "Summary", minLength: 2, default: "schema-secret" },
            count: { type: "integer", title: "Count", minimum: 1 },
            notify: { type: "boolean", title: "Notify me" },
            mode: { type: "string", title: "Mode", enum: ["safe", "fast"] },
            channels: { type: "array", title: "Channels", items: { type: "string", enum: ["email", "chat"] }, minItems: 1 },
            password: { type: "string", title: "Password" },
            metadata: { type: "object", title: "Metadata" },
          },
          required: ["summary", "password"],
        },
      },
      submittedValues: { summary: "persisted-answer" },
    });

    expect(interaction.fields.map((field) => field.key)).toEqual(["summary", "count", "notify", "mode", "channels"]);
    expect(interaction.blockedFields).toEqual([{ key: "password", label: "Password", required: true }]);
    expect(interaction.unsupportedFields).toEqual([{ key: "metadata", label: "Metadata", required: false }]);
    expect(JSON.stringify(interaction)).not.toMatch(/schema-secret|persisted-answer/u);
    expect(acpFormInitialValues(interaction)).toEqual({ summary: "", count: "", notify: false, mode: "", channels: [] });

    const result = acpFormValues(interaction, {
      summary: "ok",
      count: "2",
      notify: true,
      mode: "safe",
      channels: ["email", "invented"],
    });
    expect(result.values).toEqual({ summary: "ok", count: 2, notify: true, mode: "safe", channels: ["email"] });
    expect(result.errors.password).toContain("cannot be collected safely");
    expect(() => acpFormResponse(interaction, result.values)).toThrow("required form fields");
  });

  it("builds an in-memory ACP form response for safe primitive values", () => {
    const interaction = normalizeAcpInteraction({
      id: "form-2",
      kind: "form",
      state: "pending",
      requestSchema: {
        properties: {
          answer: { type: "string", title: "Answer" },
          approved: { type: "boolean", title: "Approved" },
        },
        required: ["answer"],
      },
    });

    expect(acpFormResponse(interaction, { answer: "Proceed", approved: false })).toEqual({
      disposition: "accept",
      action: "accept",
      content: { answer: "Proceed", approved: false },
    });
    expect(acpElicitationDecision("decline")).toEqual({ disposition: "decline", action: "decline" });
    expect(() => acpElicitationDecision("cancel")).toThrow("Invalid elicitation decision");
  });

  it("exposes only an http(s) URL with credentials, query values, and fragments removed", () => {
    const interaction = normalizeAcpInteraction({
      id: "url-1",
      kind: "url",
      state: "pending",
      requestSchema: {
        message: "Continue in your browser",
        url: "https://user:password@example.test/login?token=secret&state=one#fragment",
      },
    });
    const parsed = new URL(interaction.url);

    expect(parsed.origin + parsed.pathname).toBe("https://example.test/login");
    expect(parsed.username).toBe("");
    expect(parsed.password).toBe("");
    expect(parsed.searchParams.get("token")).toBe("[redacted]");
    expect(parsed.searchParams.get("state")).toBe("[redacted]");
    expect(parsed.hash).toBe("");
    expect(normalizeAcpInteraction({
      id: "url-2",
      kind: "url",
      state: "pending",
      requestSchema: { url: "javascript:alert(1)" },
    }).url).toBe("");
  });

  it("refreshes for direct and run-wrapped ACP interaction events", () => {
    expect(acpInteractionEventRequiresRefresh({ type: "acp_interaction_requested" })).toBe(true);
    expect(acpInteractionEventRequiresRefresh({ type: "acp_interaction_submitted" })).toBe(true);
    expect(acpInteractionEventRequiresRefresh({
      type: "run_progress",
      lastEvent: { type: "acp_interaction_resolved" },
    })).toBe(true);
    expect(acpInteractionEventRequiresRefresh({ type: "run_progress", lastEvent: { type: "text" } })).toBe(false);
  });

  it("treats stale interaction conflicts as safe settlement races", () => {
    expect(acpInteractionIsStale({ status: 409 })).toBe(true);
    expect(acpInteractionIsStale({ code: "not_pending" })).toBe(true);
    expect(acpInteractionIsStale({ status: 500, code: "failed" })).toBe(false);
  });

  it("keeps the global component out of localStorage and mounts it once in AppShell", () => {
    const component = readFileSync(resolve(import.meta.dirname, "../../ui/src/components/AcpInteractionInbox.jsx"), "utf8");
    const appShell = readFileSync(resolve(import.meta.dirname, "../../ui/src/components/AppShell.jsx"), "utf8");

    expect(component).toContain('listAcpInteractions({ state: "pending" }');
    expect(component).toContain('useSSE("global"');
    expect(component).not.toContain("localStorage");
    expect(appShell.match(/<AcpInteractionInbox \/>/g)).toHaveLength(1);
  });
});
