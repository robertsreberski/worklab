import { describe, expect, it } from "vitest";
import {
  MENTION_TYPES,
  findMentionTrigger,
  parseMentionToken,
  parseMentions,
} from "../../ui/src/lib/mentions.js";

describe("UI mentions parser parity", () => {
  it("matches the same entity types core supports", () => {
    expect(MENTION_TYPES).toEqual(["agent", "task", "project", "team", "kb", "skill", "goal", "run"]);
  });

  it("parseMentions returns token, type, id, start, end", () => {
    const text = "Hey @agent/triager and @task/T-42 thanks";
    expect(parseMentions(text)).toEqual([
      { token: "@agent/triager", type: "agent", id: "triager", start: 4, end: 18 },
      { token: "@task/T-42", type: "task", id: "T-42", start: 23, end: 33 },
    ]);
  });

  it("parseMentions ignores tokens preceded by a word character", () => {
    expect(parseMentions("ping admin@agent/x for help")).toEqual([]);
  });

  it("parseMentionToken accepts well-formed tokens and rejects malformed ones", () => {
    expect(parseMentionToken("@agent/triager")).toEqual({
      token: "@agent/triager", type: "agent", id: "triager",
    });
    expect(parseMentionToken("@skill/browser-use")).toEqual({
      token: "@skill/browser-use", type: "skill", id: "browser-use",
    });
    expect(parseMentionToken("@goal/goal-1")).toEqual({
      token: "@goal/goal-1", type: "goal", id: "goal-1",
    });
    expect(parseMentionToken("@run/run_123")).toEqual({
      token: "@run/run_123", type: "run", id: "run_123",
    });
    expect(parseMentionToken("@user/foo")).toBeNull();
    expect(parseMentionToken("agent/foo")).toBeNull();
  });
});

describe("findMentionTrigger", () => {
  it("returns the @-trigger when the caret is in a fresh mention", () => {
    expect(findMentionTrigger("hello @tri", 10)).toEqual({
      start: 6, end: 10, query: "tri",
    });
  });

  it("returns null when whitespace separates the caret from the @", () => {
    expect(findMentionTrigger("hello @agent foo", 16)).toBeNull();
  });

  it("returns null when the @ is preceded by a word character (email-style)", () => {
    expect(findMentionTrigger("foo@bar", 7)).toBeNull();
  });

  it("captures the whole `@type/id` string while typing", () => {
    expect(findMentionTrigger("hi @agent/tri", 13)).toEqual({
      start: 3, end: 13, query: "agent/tri",
    });
  });

  it("returns null when the caret is before the @", () => {
    expect(findMentionTrigger("@agent/triager", 0)).toBeNull();
  });

  it("captures the caret position when typing in the middle of a token", () => {
    const text = "hi @agent/triag";
    expect(findMentionTrigger(text, 12)).toEqual({
      start: 3, end: 12, query: "agent/tr",
    });
  });
});
