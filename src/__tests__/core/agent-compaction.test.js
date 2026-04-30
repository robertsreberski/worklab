import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../../core/db.js";
import {
  COMPACTED_CONTEXT_MARKER,
  compactToolResultForContext,
  createAgentCompactionManager,
  resolveAgentCompactionPolicy,
} from "../../core/agent-compaction.js";

function seedRun(db, runId = "run_1") {
  db.prepare("INSERT INTO task_runs (id, mode, agent_name, started_at) VALUES (?, 'execute', 'agent', 1)")
    .run(runId);
}

describe("agent compaction", () => {
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
      },
      onEvent: (event) => events.push(event),
    });

    const compacted = await manager.transformContext(messages);

    expect(compacted.length).toBeLessThan(messages.length);
    expect(compacted[0].role).toBe("user");
    expect(compacted[0].content).toContain(COMPACTED_CONTEXT_MARKER);
    expect(manager.diagnostics()).toMatchObject({ context_compactions: 1 });
    expect(events.map((event) => event.type)).toContain("context_compaction_completed");
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
});
