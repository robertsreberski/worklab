import { describe, expect, it } from "vitest";
import {
  builtinWebhookMcpServer,
  normalizeWorklabInboundWebhookPayload,
  normalizeWorklabOptionalWebhookId,
  normalizeWorklabWebhookId,
} from "../../core/index.js";

describe("Worklab webhook adapter", () => {
  it("normalizes webhook ids through the local Worklab adapter", () => {
    expect(normalizeWorklabWebhookId(" Hook_1234 ")).toBe("Hook_1234");
    expect(normalizeWorklabOptionalWebhookId("")).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it("normalizes inbound webhook payloads through the local Worklab adapter", () => {
    const payload = normalizeWorklabInboundWebhookPayload({
      headers: { "content-type": "application/json" },
      query: { source: "test" },
      body: Buffer.from(JSON.stringify({ ok: true })),
    });

    expect(payload).toMatchObject({
      content_type: "application/json",
      query: { source: "test" },
      body_kind: "json",
    });
    expect(payload.body_preview).toContain("\"ok\": true");
  });

  it("builds the built-in webhook MCP server config through the local adapter", () => {
    const server = builtinWebhookMcpServer(process.cwd());

    expect(server.command).toBe(process.execPath);
    expect(server.args?.[0]).toMatch(/webhooks.+server\.js$/);
  });
});
