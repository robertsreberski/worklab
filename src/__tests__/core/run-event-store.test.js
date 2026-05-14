import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRunEventStore } from "../../core/index.js";

describe("RunEventStore", () => {
  const tempDirs = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempDataDir() {
    const dir = mkdtempSync(join(tmpdir(), "worklab-run-event-store-"));
    tempDirs.push(dir);
    return dir;
  }

  it("loads raw JSONL events from a run path inside the data directory", () => {
    const dataDir = tempDataDir();
    const logDir = join(dataDir, "logs", "runs");
    mkdirSync(logDir, { recursive: true });
    const rawPath = join(logDir, "run.jsonl");
    writeFileSync(rawPath, [
      JSON.stringify({ type: "started" }),
      "not json",
      JSON.stringify({ type: "final", text: "done" }),
    ].join("\n"));

    const store = createRunEventStore({ dataDir });

    expect(store.readRawEvents({ raw_output_path: rawPath })).toEqual([
      { type: "started" },
      { type: "final", text: "done" },
    ]);
  });

  it("rejects raw log paths outside the data directory", () => {
    const dataDir = tempDataDir();
    const outside = join(tempDataDir(), "outside.jsonl");
    writeFileSync(outside, JSON.stringify({ type: "started" }));

    const store = createRunEventStore({ dataDir });

    expect(store.readRawEvents({ raw_output_path: outside })).toBeNull();
    try {
      store.readRawText({ raw_output_path: outside });
      throw new Error("expected readRawText to reject outside path");
    } catch (err) {
      expect(err).toMatchObject({ code: "forbidden" });
    }
  });

  it("shapes full logs from raw events with full payload fidelity", () => {
    const store = createRunEventStore();
    const log = store.shapeLog(
      { id: "log", events: "[]", event_count: 0 },
      { events: "full" },
      { rawEvents: [{ type: "started" }, { type: "final" }] },
    );

    expect(log).toMatchObject({
      source: "raw_output_path",
      payload_fidelity: "full",
      events_truncated: false,
      event_count: 2,
    });
    expect(log.events).toHaveLength(2);
  });

  it("tails compacted SQLite log events by visible event units", () => {
    const store = createRunEventStore();
    const log = store.shapeLog(
      {
        id: "log",
        events: JSON.stringify([{ type: "one" }, { type: "two" }, { type: "three" }]),
        event_count: 3,
        events_compaction_strategy: "slim-db",
      },
      { events: "tail", limit: "2" },
    );

    expect(log).toMatchObject({
      source: "agent_logs.events",
      payload_fidelity: "compacted",
      events_truncated: true,
      event_count: 3,
    });
    expect(log.events.map((event) => event.type)).toEqual(["two", "three"]);
  });
});
