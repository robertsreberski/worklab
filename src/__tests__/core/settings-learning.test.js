import { describe, expect, it } from "vitest";
import { makeTestDb } from "../helpers/test-db.js";
import { readSettings, writeSettings } from "../../core/settings.js";

describe("agent learning settings", () => {
  it("defaults to Worklab-native learning", () => {
    const db = makeTestDb();
    const settings = readSettings(db);
    expect(settings.agent_learning_enabled).toBe(true);
    expect(settings.agent_learning_injected_limit).toBe(6);
    expect(settings.agent_learning_auto_approve_threshold).toBe(0.85);
  });

  it("validates native learning controls", () => {
    const db = makeTestDb();
    const settings = writeSettings(db, {
      agent_learning_enabled: false,
      agent_learning_injected_limit: 12,
      agent_learning_auto_approve_threshold: 0.7,
    });

    expect(settings.agent_learning_enabled).toBe(false);
    expect(settings.agent_learning_injected_limit).toBe(12);
    expect(settings.agent_learning_auto_approve_threshold).toBe(0.7);
    expect(() => writeSettings(db, { agent_learning_injected_limit: 0 })).toThrow(/agent_learning_injected_limit/);
    expect(() => writeSettings(db, { agent_learning_auto_approve_threshold: 1.1 })).toThrow(/agent_learning_auto_approve_threshold/);
  });

  it("does not expose persisted unknown settings", () => {
    const db = makeTestDb();
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("legacy_option", JSON.stringify("old"));
    expect(readSettings(db)).not.toHaveProperty("legacy_option");
  });
});
