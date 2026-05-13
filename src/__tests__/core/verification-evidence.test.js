import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  crossCheckVerificationEvidence,
  crossCheckVerificationEvidenceWithAdjudicator,
} from "../../core/verification-evidence.js";
import { makeTestDb } from "../helpers/test-db.js";
import { createProvider, upsertModel } from "../../core/providers.js";

function seedRunWithEvents(db, runId, events) {
  const now = Date.now();
  db.prepare("INSERT INTO task_runs (id, mode, agent_name, started_at, status) VALUES (?, 'review', 'reviewer', ?, 'succeeded')")
    .run(runId, now);
  db.prepare("INSERT INTO agent_logs (id, task_run_id, events, status, created_at) VALUES (?, ?, ?, 'complete', ?)")
    .run(`log-${runId}`, runId, JSON.stringify(events), now);
}

function seedRunWithRawLog(db, runId, { compactEvents = [], rawEvents = [] } = {}) {
  const now = Date.now();
  const root = mkdtempSync(join(tmpdir(), "worklab-evidence-"));
  const rawDir = join(root, "logs", "runs");
  mkdirSync(rawDir, { recursive: true });
  const rawPath = join(rawDir, `${runId}.jsonl`);
  writeFileSync(rawPath, rawEvents.map((event) => JSON.stringify(event)).join("\n") + "\n");
  db.prepare("INSERT INTO task_runs (id, mode, agent_name, started_at, status, raw_output_path) VALUES (?, 'review', 'reviewer', ?, 'succeeded', ?)")
    .run(runId, now, rawPath);
  db.prepare("INSERT INTO agent_logs (id, task_run_id, events, status, created_at) VALUES (?, ?, ?, 'complete', ?)")
    .run(`log-${runId}`, runId, JSON.stringify(compactEvents), now);
  return rawPath;
}

function seedAdjudicatorModel(db, {
  providerType = "ollama",
  baseUrl = "http://127.0.0.1:11434",
  modelName = "gpt-oss-safeguard:20b",
} = {}) {
  const provider = createProvider({
    db,
    name: `${providerType}-adjudicator`,
    provider_type: providerType,
    base_url: baseUrl,
    trust_public_url: /^https:\/\//.test(baseUrl),
  });
  upsertModel({
    db,
    providerId: provider.id,
    modelName,
    displayName: modelName,
    capabilities: { chat: true, json_mode: true },
    enabled: true,
  });
  return { provider, modelRef: `vercel:${provider.id}:${modelName}` };
}

describe("crossCheckVerificationEvidence", () => {
  it("returns zeros when there is no evidence", () => {
    const db = makeTestDb();
    const result = crossCheckVerificationEvidence(db, { reviewRunId: "r1", evidence: [] });
    expect(result).toEqual({ totalChecked: 0, matchedCount: 0, unmatchedCount: 0 });
  });

  it("treats kind='n_a' rows as documentation, not as something to cross-check", () => {
    const db = makeTestDb();
    seedRunWithEvents(db, "r1", []);
    const result = crossCheckVerificationEvidence(db, {
      reviewRunId: "r1",
      evidence: [{ kind: "n_a", reason: "research only" }],
    });
    expect(result).toEqual({ totalChecked: 0, matchedCount: 0, unmatchedCount: 0 });
  });

  it("matches evidence command against tool_use input across the run + parent run", () => {
    const db = makeTestDb();
    seedRunWithEvents(db, "review-1", [
      {
        type: "sdk_event",
        event: {
          type: "assistant",
          message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test src/foo" } }] },
        },
      },
    ]);
    seedRunWithEvents(db, "exec-1", [
      {
        type: "assistant",
        content: [{ type: "tool_use", name: "Bash", input: { command: "npm run build" } }],
      },
    ]);
    const result = crossCheckVerificationEvidence(db, {
      reviewRunId: "review-1",
      parentRunId: "exec-1",
      evidence: [
        { kind: "test", command_or_url: "npm test src/foo" },
        { kind: "build", command_or_url: "npm run build" },
        { kind: "lint", command_or_url: "npm run lint" },
      ],
    });
    expect(result.totalChecked).toBe(3);
    expect(result.matchedCount).toBe(2);
    expect(result.unmatchedCount).toBe(1);
    expect(result.unmatchedRows).toEqual([
      expect.objectContaining({
        evidence_index: 2,
        command_or_url: "npm run lint",
        match_source: null,
      }),
    ]);
  });

  it("matches evidence against the full raw JSONL log when compact DB events omitted the tool input", () => {
    const db = makeTestDb();
    seedRunWithRawLog(db, "review-raw", {
      compactEvents: [
        {
          type: "sdk_event",
          event: {
            type: "assistant",
            message: {
              content: [{
                type: "tool_use",
                id: "cmd-1",
                name: "command_execution",
                input_omitted: true,
                input_preview: "{\"command\":\"/bin/zsh -lc 'other command'\"}",
              }],
            },
          },
        },
      ],
      rawEvents: [
        {
          type: "sdk_event",
          event: {
            type: "assistant",
            message: {
              content: [{
                type: "tool_use",
                id: "cmd-1",
                name: "command_execution",
                input: { command: "/bin/zsh -lc 'git status --short --branch --untracked-files=normal'" },
              }],
            },
          },
        },
      ],
    });

    const result = crossCheckVerificationEvidence(db, {
      reviewRunId: "review-raw",
      evidence: [
        {
          kind: "manual_check",
          command_or_url: "git status --short --branch --untracked-files=normal",
        },
      ],
    });

    expect(result).toMatchObject({
      totalChecked: 1,
      matchedCount: 1,
      unmatchedCount: 0,
    });
    expect(result.matchedRows[0]).toMatchObject({
      match_source: "deterministic",
      log_source: "raw_log",
    });
  });

  it("uses compact input_preview as a fallback when raw JSONL is unavailable", () => {
    const db = makeTestDb();
    seedRunWithEvents(db, "review-compact", [
      {
        type: "sdk_event",
        event: {
          type: "assistant",
          message: {
            content: [{
              type: "tool_use",
              id: "cmd-1",
              name: "command_execution",
              input_omitted: true,
              input_preview: "{\"command\":\"/bin/zsh -lc 'composer test -- --filter OrchestratedTranslationJobExecutorTest'\"}",
            }],
          },
        },
      },
    ]);

    const result = crossCheckVerificationEvidence(db, {
      reviewRunId: "review-compact",
      evidence: [
        {
          kind: "test",
          command_or_url: "composer test -- --filter OrchestratedTranslationJobExecutorTest",
        },
      ],
    });

    expect(result).toMatchObject({
      totalChecked: 1,
      matchedCount: 1,
      unmatchedCount: 0,
    });
    expect(result.matchedRows[0]).toMatchObject({
      match_source: "deterministic",
      log_source: "compact_preview",
    });
  });

  it("matches MCP tool evidence written as tool name plus key=value arguments", () => {
    const db = makeTestDb();
    seedRunWithEvents(db, "review-1", [
      {
        type: "assistant",
        content: [{
          type: "tool_use",
          name: "mcp__worklab__run_log_read",
          input: {
            run_id: "sSys0u6XiEjxs8swopAsP",
            mode: "summary",
            limit_bytes: 60000,
          },
        }],
      },
    ]);

    const result = crossCheckVerificationEvidence(db, {
      reviewRunId: "review-1",
      evidence: [
        {
          kind: "manual_check",
          command_or_url: "mcp__worklab__run_log_read run_id=sSys0u6XiEjxs8swopAsP mode=summary limit_bytes=60000",
        },
      ],
    });

    expect(result).toMatchObject({
      totalChecked: 1,
      matchedCount: 1,
      unmatchedCount: 0,
    });
    expect(result.matchedRows[0]).toMatchObject({
      evidence_index: 0,
      match_source: "deterministic",
      matched_tool_call: "review-1:0",
    });
  });

  it("matches generic tool key=value evidence against structured JSON input", () => {
    const db = makeTestDb();
    seedRunWithEvents(db, "review-1", [
      {
        type: "assistant",
        content: [{
          type: "tool_use",
          name: "mcp__external_mcp__external_mcp_execute_tool",
          input: {
            provider: "linear",
            tool: "get_issue",
            params: { id: "T-252" },
          },
        }],
      },
    ]);

    const result = crossCheckVerificationEvidence(db, {
      reviewRunId: "review-1",
      evidence: [
        {
          kind: "manual_check",
          command_or_url: "mcp__external_mcp__external_mcp_execute_tool provider=linear tool=get_issue id=T-252",
        },
      ],
    });

    expect(result.matchedCount).toBe(1);
    expect(result.matchedRows[0]).toMatchObject({
      match_source: "deterministic",
      matched_tool_call: "review-1:0",
    });
  });

  it("does not match tool key=value evidence when any argument differs", () => {
    const db = makeTestDb();
    seedRunWithEvents(db, "review-1", [
      {
        type: "assistant",
        content: [{
          type: "tool_use",
          name: "mcp__worklab__run_log_read",
          input: {
            run_id: "sSys0u6XiEjxs8swopAsP",
            mode: "summary",
            limit_bytes: 60000,
          },
        }],
      },
    ]);

    const result = crossCheckVerificationEvidence(db, {
      reviewRunId: "review-1",
      evidence: [
        {
          kind: "manual_check",
          command_or_url: "mcp__worklab__run_log_read run_id=sSys0u6XiEjxs8swopAsP mode=summary limit_bytes=50000",
        },
      ],
    });

    expect(result).toMatchObject({
      totalChecked: 1,
      matchedCount: 0,
      unmatchedCount: 1,
    });
  });

  it("matches grouped shell evidence when every command segment appears in logged tool calls", () => {
    const db = makeTestDb();
    seedRunWithEvents(db, "review-1", []);
    seedRunWithEvents(db, "exec-1", [
      {
        type: "assistant",
        content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }],
      },
      {
        type: "assistant",
        content: [{ type: "tool_use", name: "Bash", input: { command: "npm run build:ui" } }],
      },
    ]);
    const result = crossCheckVerificationEvidence(db, {
      reviewRunId: "review-1",
      parentRunId: "exec-1",
      evidence: [
        { kind: "test", command_or_url: "npm test; npm run build:ui" },
      ],
    });
    expect(result).toMatchObject({
      totalChecked: 1,
      matchedCount: 1,
      unmatchedCount: 0,
    });
    expect(result.matchedRows[0]).toMatchObject({
      evidence_index: 0,
      match_source: "deterministic",
      matched_tool_call: expect.stringContaining("multiple"),
    });
  });

  it("matches URL evidence with browser prose against a logged URL tool call", () => {
    const db = makeTestDb();
    seedRunWithEvents(db, "review-1", [
      {
        type: "assistant",
        content: [{ type: "tool_use", name: "browser_navigate", input: { url: "http://localhost:8882/" } }],
      },
    ]);
    const result = crossCheckVerificationEvidence(db, {
      reviewRunId: "review-1",
      evidence: [
        { kind: "manual_check", command_or_url: "http://localhost:8882/ via Playwright browser_snapshot" },
      ],
    });
    expect(result).toMatchObject({
      totalChecked: 1,
      matchedCount: 1,
      unmatchedCount: 0,
    });
    expect(result.matchedRows[0]).toMatchObject({
      evidence_index: 0,
      match_source: "deterministic",
      matched_tool_call: "review-1:0",
    });
  });

  it("uses the configured verification adjudicator to rescue deterministic misses against actual tool calls", async () => {
    const db = makeTestDb();
    const { modelRef } = seedAdjudicatorModel(db);
    seedRunWithEvents(db, "review-1", []);
    seedRunWithEvents(db, "exec-1", [
      {
        type: "assistant",
        content: [{ type: "tool_use", name: "Bash", input: { command: "npm test src/__tests__/core/verification-evidence.test.js" } }],
      },
    ]);
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        message: {
          content: JSON.stringify({
            decision: "match",
            matched_tool_call_id: "exec-1:0",
            reason: "The evidence is a prose summary of the logged npm test command.",
            confidence: 0.91,
          }),
        },
      }),
    }));
    const result = await crossCheckVerificationEvidenceWithAdjudicator(db, {
      reviewRunId: "review-1",
      parentRunId: "exec-1",
      evidence: [
        { kind: "test", command_or_url: "focused verification-evidence vitest run" },
      ],
      adjudicator: {
        mode: "on",
        model: modelRef,
        timeoutMs: 1000,
      },
      fetchImpl,
    });

    expect(result).toMatchObject({
      totalChecked: 1,
      matchedCount: 1,
      unmatchedCount: 0,
    });
    expect(result.matchedRows[0]).toMatchObject({
      evidence_index: 0,
      match_source: "adjudicator",
      matched_tool_call: "exec-1:0",
      confidence: 0.91,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:11434/api/chat");
    expect(JSON.parse(init.body)).toMatchObject({
      model: "gpt-oss-safeguard:20b",
      stream: false,
    });
  });

  it("fails closed when the adjudicator returns malformed output", async () => {
    const db = makeTestDb();
    const { modelRef } = seedAdjudicatorModel(db);
    seedRunWithEvents(db, "review-1", []);
    seedRunWithEvents(db, "exec-1", [
      {
        type: "assistant",
        content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }],
      },
    ]);
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ message: { content: "not json" } }),
    }));
    const result = await crossCheckVerificationEvidenceWithAdjudicator(db, {
      reviewRunId: "review-1",
      parentRunId: "exec-1",
      evidence: [
        { kind: "test", command_or_url: "test run summary" },
      ],
      adjudicator: { mode: "on", model: modelRef, timeoutMs: 1000 },
      fetchImpl,
    });

    expect(result).toMatchObject({
      totalChecked: 1,
      matchedCount: 0,
      unmatchedCount: 1,
    });
    expect(result.unmatchedRows[0]).toMatchObject({
      evidence_index: 0,
      match_source: null,
    });
    expect(result.unmatchedRows[0].reason).toMatch(/adjudicator/i);
  });

  it("fails closed when the adjudicator references a tool call id that was not provided", async () => {
    const db = makeTestDb();
    const { modelRef } = seedAdjudicatorModel(db);
    seedRunWithEvents(db, "review-1", []);
    seedRunWithEvents(db, "exec-1", [
      {
        type: "assistant",
        content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }],
      },
    ]);
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        message: {
          content: JSON.stringify({
            decision: "match",
            matched_tool_call_id: "other-run:99",
            reason: "Looks similar.",
            confidence: 0.95,
          }),
        },
      }),
    }));
    const result = await crossCheckVerificationEvidenceWithAdjudicator(db, {
      reviewRunId: "review-1",
      parentRunId: "exec-1",
      evidence: [
        { kind: "test", command_or_url: "test run summary" },
      ],
      adjudicator: { mode: "on", model: modelRef, timeoutMs: 1000 },
      fetchImpl,
    });

    expect(result.unmatchedCount).toBe(1);
    expect(result.unmatchedRows[0].reason).toMatch(/unknown tool call id/i);
  });

  it("calls OpenAI-compatible provider endpoints for non-Ollama adjudicator models", async () => {
    const db = makeTestDb();
    const { modelRef } = seedAdjudicatorModel(db, {
      providerType: "openai_compat",
      baseUrl: "http://127.0.0.1:12345",
      modelName: "local-safeguard",
    });
    seedRunWithEvents(db, "review-1", []);
    seedRunWithEvents(db, "exec-1", [
      {
        type: "assistant",
        content: [{ type: "tool_use", name: "Bash", input: { command: "npm run build:ui" } }],
      },
    ]);
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              decision: "match",
              matched_tool_call_id: "exec-1:0",
              reason: "The evidence summarizes the logged UI build.",
              confidence: 0.88,
            }),
          },
        }],
      }),
    }));

    const result = await crossCheckVerificationEvidenceWithAdjudicator(db, {
      reviewRunId: "review-1",
      parentRunId: "exec-1",
      evidence: [
        { kind: "build", command_or_url: "UI production build completed" },
      ],
      adjudicator: { mode: "on", model: modelRef, timeoutMs: 1000 },
      fetchImpl,
    });

    expect(result.matchedCount).toBe(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:12345/v1/chat/completions");
    expect(JSON.parse(init.body)).toMatchObject({
      model: "local-safeguard",
      response_format: { type: "json_object" },
    });
  });

  it("reports all unmatched when the run has no tool calls at all", () => {
    const db = makeTestDb();
    seedRunWithEvents(db, "review-1", []);
    const result = crossCheckVerificationEvidence(db, {
      reviewRunId: "review-1",
      evidence: [{ kind: "test", command_or_url: "npm test" }],
    });
    expect(result.totalChecked).toBe(1);
    expect(result.matchedCount).toBe(0);
    expect(result.unmatchedCount).toBe(1);
  });

  it("counts evidence with no command_or_url as unmatched (no way to verify)", () => {
    const db = makeTestDb();
    seedRunWithEvents(db, "review-1", [
      { type: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "echo hi" } }] },
    ]);
    const result = crossCheckVerificationEvidence(db, {
      reviewRunId: "review-1",
      evidence: [{ kind: "test" }],
    });
    expect(result.unmatchedCount).toBe(1);
  });
});
