import { describe, expect, it } from "vitest";
import {
  agentSupportsFastMode,
  agentSupportsOneMillionContext,
  formatMemoryBytes,
  learningMemoryMeta,
  learningMemoryStatusLabel,
  learningMemoryStatusTone,
  memoryContentPlaceholder,
  memoryFreshnessLabel,
  memoryFreshnessStatus,
  memoryMetaItems,
} from "../../ui/src/routes/AgentEdit.jsx";

describe("agent runtime UI helpers", () => {
  it("shows the 1M context switch only for eligible Opus Claude models", () => {
    expect(agentSupportsOneMillionContext(null)).toBe(false);
    expect(agentSupportsOneMillionContext(undefined)).toBe(false);
    expect(agentSupportsOneMillionContext({ value: "claude:claude-opus-4-7" })).toBe(true);
    expect(agentSupportsOneMillionContext({ value: "claude:claude-opus-4-6" })).toBe(true);
    expect(agentSupportsOneMillionContext({ value: "claude:claude-sonnet-4-6" })).toBe(false);
    expect(agentSupportsOneMillionContext({ value: "codex:gpt-5.5" })).toBe(false);
  });

  it("shows the fast mode switch only for Codex GPT models", () => {
    expect(agentSupportsFastMode(null)).toBe(false);
    expect(agentSupportsFastMode(undefined)).toBe(false);
    expect(agentSupportsFastMode({ value: "codex:gpt-5.5" })).toBe(true);
    expect(agentSupportsFastMode({ value: "codex:gpt-5.4" })).toBe(true);
    expect(agentSupportsFastMode({ value: "codex:gpt-5.4-mini" })).toBe(true);
    expect(agentSupportsFastMode({ value: "pi:openai-codex:gpt-5.5" })).toBe(false);
    expect(agentSupportsFastMode({ value: "codex:o4-mini" })).toBe(false);
  });
});

describe("agent memory UI helpers", () => {
  it("maps memory freshness to user-facing labels and pill statuses", () => {
    expect(memoryFreshnessLabel({ freshness: "current" })).toBe("Current");
    expect(memoryFreshnessStatus({ freshness: "current" })).toBe("complete");

    expect(memoryFreshnessLabel({ freshness: "stale" })).toBe("Needs consolidation");
    expect(memoryFreshnessStatus({ freshness: "stale" })).toBe("review");

    expect(memoryFreshnessLabel({ freshness: "not_consolidated", exists: false })).toBe("No memory yet");
    expect(memoryFreshnessLabel({ freshness: "no_journal" })).toBe("No journal yet");
    expect(memoryFreshnessLabel({ freshness: "consolidating" })).toBe("Consolidating");
    expect(memoryFreshnessStatus({ freshness: "consolidating" })).toBe("running");
  });

  it("formats memory size and placeholder text", () => {
    expect(formatMemoryBytes(0)).toBe("0 B");
    expect(formatMemoryBytes(512)).toBe("512 B");
    expect(formatMemoryBytes(2048)).toBe("2.0 KB");
    expect(formatMemoryBytes(2 * 1024 * 1024)).toBe("2.0 MB");

    expect(memoryContentPlaceholder(null)).toBe("Loading memory...");
    expect(memoryContentPlaceholder({ exists: false })).toBe("No consolidated memory has been written yet.");
    expect(memoryContentPlaceholder({ exists: true })).toBe("");
  });

  it("builds compact metadata for the memory rail card", () => {
    const items = memoryMetaItems({
      freshness: "stale",
      exists: true,
      size_bytes: 2048,
      updated_at: null,
      last_consolidated_at: null,
      last_run_id: "run-1",
      journal_exists: true,
      journal_changed: true,
    });

    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "State", value: "Needs consolidation" }),
      expect.objectContaining({ label: "Memory", value: "2.0 KB" }),
      expect.objectContaining({ label: "Updated", value: "Never" }),
      expect.objectContaining({ label: "Journal", value: "Changed" }),
      expect.objectContaining({ label: "Run", value: "run-1", mono: true }),
    ]));
  });

  it("maps structured learning memory statuses", () => {
    expect(learningMemoryStatusLabel({ status: "draft" })).toBe("Draft");
    expect(learningMemoryStatusTone({ status: "draft" })).toBe("review");
    expect(learningMemoryStatusLabel({ status: "approved" })).toBe("Approved");
    expect(learningMemoryStatusTone({ status: "approved" })).toBe("complete");
    expect(learningMemoryMeta([
      { status: "draft" },
      { status: "approved" },
      { status: "archived" },
    ])).toEqual([
      { label: "Active", value: "2" },
      { label: "Draft", value: "1" },
      { label: "Approved", value: "1" },
    ]);
  });

  it("uses API learning-memory summary counts when available", () => {
    expect(learningMemoryMeta([{ status: "draft" }], {
      active: 12,
      draft: 3,
      approved: 9,
    })).toEqual([
      { label: "Active", value: "12" },
      { label: "Draft", value: "3" },
      { label: "Approved", value: "9" },
    ]);
  });
});
