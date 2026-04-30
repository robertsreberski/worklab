import { describe, expect, it } from "vitest";
import { openDb } from "../../core/db/open.js";
import { runMigrations } from "../../core/db/migrations/runner.js";
import {
  COMPACTED_CONTEXT_MARKER,
  compactToolResultForContext,
  createAgentCompactionManager,
  isLikelyContextTermination,
  resolveAgentCompactionPolicy,
} from "../../agent/compaction.js";

function seedRun(db, runId = "run_1") {
  db.prepare("INSERT INTO task_runs (id, mode, agent_name, started_at) VALUES (?, 'execute', 'agent', 1)")
    .run(runId);
}

describe("agent compaction", () => {
  it("uses pruning-first defaults for long sessions", () => {
    const policy = resolveAgentCompactionPolicy({}, { contextWindow: 128000 });

    expect(policy.triggerRatio).toBe(0.85);
    expect(policy.toolPayloadCompactionTriggerChars).toBe(0);
    expect(policy.toolPruneTriggerTokens).toBe(40000);
    expect(policy.compactionMinSavingsTokens).toBe(20000);
    expect(policy.searchResultLimit).toBe(100);
  });

  it("compacts old messages and records a durable compaction row", async () => {
    const db = openDb(":memory:");
    runMigrations(db);
    seedRun(db);
    const events = [];
    const messages = Array.from({ length: 80 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `${index} ${"context ".repeat(80)}`,
      timestamp: index + 1,
    }));
    const manager = createAgentCompactionManager({
      db,
      runId: "run_1",
      providerKind: "codex",
      modelReference: "codex:gpt-test",
      model: { id: "gpt-test", contextWindow: 32000 },
      settings: {
        agent_compaction_trigger_ratio: 0.2,
        agent_compaction_keep_recent_tokens: 4000,
        agent_compaction_summary_max_tokens: 1000,
        agent_compaction_min_savings_tokens: 0,
      },
      onEvent: (event) => events.push(event),
    });

    const originalLength = messages.length;
    const compacted = await manager.transformContext(messages);

    expect(compacted).toBe(messages);
    expect(compacted.length).toBeLessThan(originalLength);
    expect(compacted[0].role).toBe("user");
    expect(compacted[0].content).toContain(COMPACTED_CONTEXT_MARKER);
    expect(manager.diagnostics()).toMatchObject({ context_compactions: 1 });
    expect(events.map((event) => event.type)).toContain("context_compaction_completed");
    await manager.transformContext(messages);
    expect(events.filter((event) => event.type === "context_compaction_completed")).toHaveLength(1);
    const row = db.prepare("SELECT task_run_id, seq, tokens_before, tokens_after, summary FROM run_compactions").get();
    expect(row.task_run_id).toBe("run_1");
    expect(row.seq).toBe(1);
    expect(row.tokens_before).toBeGreaterThan(row.tokens_after);
    expect(row.summary).toContain("Recent user/task instructions");
  });

  it("caps oversized tool results before they enter model context", () => {
    const policy = resolveAgentCompactionPolicy({
      agent_tool_text_limit_chars: 1200,
      agent_image_inline_max_bytes: 100,
    }, { contextWindow: 32000 });
    const result = {
      content: [
        { type: "text", text: "x".repeat(4000) },
        { type: "image", data: "a".repeat(1000), mimeType: "image/png" },
      ],
      details: { tool: "Read" },
    };

    const compacted = compactToolResultForContext(result, policy, { toolName: "Read" });

    expect(compacted.changed).toBe(true);
    expect(compacted.result.content[0].text.length).toBeLessThan(4000);
    expect(compacted.result.content[0].text).toContain("truncated Read result");
    expect(compacted.result.content[1].text).toContain("omitted inline image");
    expect(compacted.result.details.context_compacted).toBe(true);
  });

  it("prunes old tool results before forcing a full transcript compaction", async () => {
    const events = [];
    const manager = createAgentCompactionManager({
      model: { id: "gpt-test", contextWindow: 32000 },
      settings: {
        agent_compaction_trigger_ratio: 0.95,
        agent_compaction_keep_recent_tokens: 4000,
        agent_tool_prune_trigger_tokens: 1000,
      },
      onEvent: (event) => events.push(event),
    });
    const messages = [];
    for (let index = 0; index < 18; index += 1) {
      messages.push({ role: "user", content: `step ${index}` });
      messages.push({ role: "assistant", content: [{ type: "toolCall", id: `read-${index}`, name: "Read", arguments: { file_path: `file-${index}.js` } }] });
      messages.push({
        role: "toolResult",
        toolName: "Read",
        content: [{ type: "text", text: `output ${index} ${"x".repeat(4000)}` }],
        details: { tool: "Read" },
      });
    }
    messages.push({ role: "user", content: "recent instruction" });

    const pruned = await manager.transformContext(messages);

    expect(pruned).toBe(messages);
    expect(pruned).toHaveLength(messages.length);
    expect(pruned.some((message) => message.role === "toolResult" && message.details?.context_pruned)).toBe(true);
    expect(manager.diagnostics()).toMatchObject({
      context_compactions: 0,
      tool_results_pruned: expect.any(Number),
    });
    expect(events.map((event) => event.type)).toContain("tool_context_pruned");
    const pruneEvent = events.find((event) => event.type === "tool_context_pruned");
    expect(pruneEvent.tokens_saved).toBe(pruneEvent.tokens_before - pruneEvent.tokens_after);
    expect(pruneEvent.pruned_tool_tokens_saved).toBe(pruneEvent.pruned_tool_tokens_before - pruneEvent.pruned_tool_tokens_after);
  });

  it("does not repeatedly report the same pruned tool results", async () => {
    const events = [];
    const manager = createAgentCompactionManager({
      model: { id: "gpt-test", contextWindow: 32000 },
      settings: {
        agent_compaction_trigger_ratio: 0.95,
        agent_compaction_keep_recent_tokens: 4000,
        agent_tool_prune_trigger_tokens: 1000,
      },
      onEvent: (event) => events.push(event),
    });
    const messages = [];
    for (let index = 0; index < 18; index += 1) {
      messages.push({ role: "user", content: `step ${index}` });
      messages.push({ role: "assistant", content: [{ type: "toolCall", id: `read-${index}`, name: "Read", arguments: { file_path: `file-${index}.js` } }] });
      messages.push({
        role: "toolResult",
        toolName: "Read",
        content: [{ type: "text", text: `output ${index} ${"x".repeat(4000)}` }],
        details: { tool: "Read" },
      });
    }
    messages.push({ role: "user", content: "recent instruction" });

    await manager.transformContext(messages);
    const firstPruned = manager.diagnostics().tool_results_pruned;
    messages.push({ role: "assistant", content: [{ type: "toolCall", id: "edit-small", name: "Edit", arguments: { file_path: "file.js" } }] });
    messages.push({
      role: "toolResult",
      toolName: "Edit",
      content: [{ type: "text", text: "Successfully edited file.js" }],
      details: { tool: "Edit" },
    });
    await manager.transformContext(messages);

    expect(events.filter((event) => event.type === "tool_context_pruned")).toHaveLength(1);
    expect(manager.diagnostics().tool_results_pruned).toBe(firstPruned);
  });

  it("does not force full compaction from tool payload accounting by default", async () => {
    const manager = createAgentCompactionManager({
      model: { id: "gpt-test", contextWindow: 32000 },
      settings: {
        agent_compaction_trigger_ratio: 0.95,
        agent_compaction_keep_recent_tokens: 4000,
        agent_tool_prune_trigger_tokens: 0,
      },
    });
    const messages = Array.from({ length: 80 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `${index} ${"context ".repeat(10)}`,
      timestamp: index + 1,
    }));

    await manager.afterToolCall({
      toolCall: { id: "read-1", name: "Read" },
      result: { content: [{ type: "text", text: "x".repeat(85_000) }], details: { tool: "Read" } },
    });
    const next = await manager.transformContext(messages);

    expect(next).toBe(messages);
    expect(manager.diagnostics()).toMatchObject({
      context_compactions: 0,
      context_compaction_pending_reason: null,
      tool_payload_compaction_trigger_chars: 0,
    });
  });

  it("carries prior summaries forward across token-budget compactions", async () => {
    const db = openDb(":memory:");
    runMigrations(db);
    seedRun(db);
    const manager = createAgentCompactionManager({
      db,
      runId: "run_1",
      providerKind: "codex",
      modelReference: "codex:gpt-test",
      model: { id: "gpt-test", contextWindow: 32000 },
      settings: {
        agent_compaction_trigger_ratio: 0.2,
        agent_compaction_keep_recent_tokens: 4000,
        agent_compaction_min_savings_tokens: 0,
        agent_tool_prune_trigger_tokens: 0,
      },
    });
    const messages = Array.from({ length: 120 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `${index} ${"context ".repeat(25)}`,
      timestamp: index + 1,
    }));

    const originalLength = messages.length;
    const first = await manager.transformContext(messages);
    expect(first).toBe(messages);
    expect(first.length).toBeLessThan(originalLength);
    expect(db.prepare("SELECT trigger FROM run_compactions WHERE seq = 1").get().trigger).toBe("token_budget");

    const secondMessages = [
      first[0],
      ...Array.from({ length: 120 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `follow-up ${index} ${"context ".repeat(25)}`,
        timestamp: index + 200,
      })),
    ];
    await manager.transformContext(secondMessages);

    const second = db.prepare("SELECT summary FROM run_compactions WHERE seq = 2").get();
    expect(second.summary).toContain("Historical context from previous compactions");
    expect(manager.diagnostics()).toMatchObject({
      context_compactions: 2,
      context_compaction_pending_reason: null,
      tool_payload_compaction_trigger_chars: 0,
    });
  });
});

describe("isLikelyContextTermination", () => {
  it("returns false when only per-call pruning happened and context is well below the trigger", () => {
    expect(isLikelyContextTermination("terminated", {
      tool_results_pruned: 58,
      tool_results_compacted: 0,
      context_compactions: 0,
      context_tokens_estimate_max: 78748,
      context_compaction_trigger_tokens: 208000,
    })).toBe(false);
  });

  it("returns true when compaction has run at least once", () => {
    expect(isLikelyContextTermination("terminated", {
      context_compactions: 1,
      context_tokens_estimate_max: 50000,
      context_compaction_trigger_tokens: 208000,
    })).toBe(true);
  });

  it("returns true when the estimate sits above 85% of the trigger threshold", () => {
    expect(isLikelyContextTermination("aborted before final output", {
      context_compactions: 0,
      context_tokens_estimate_max: 200000,
      context_compaction_trigger_tokens: 208000,
    })).toBe(true);
  });

  it("ignores high tool_results_pruned without genuine context pressure", () => {
    expect(isLikelyContextTermination("stream aborted", {
      tool_results_pruned: 200,
      context_compactions: 0,
      context_tokens_estimate_max: 100000,
      context_compaction_trigger_tokens: 208000,
    })).toBe(false);
  });

  it("returns false for unrelated error messages", () => {
    expect(isLikelyContextTermination("rate limit reached", {
      context_compactions: 5,
    })).toBe(false);
  });
});
