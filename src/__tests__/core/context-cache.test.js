import { describe, it, expect } from "vitest";
import { createContextCache, makeContextCacheKey, shortHash } from "../../core/context-cache.js";

describe("createContextCache", () => {
  it("returns null on miss and tracks misses/hits", () => {
    const cache = createContextCache({ maxEntries: 4 });
    expect(cache.get("x")).toBeNull();
    cache.set("x", { value: 1 });
    expect(cache.get("x")).toEqual({ value: 1 });
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, size: 1 });
  });

  it("evicts the least-recently-used entry past maxEntries", () => {
    const cache = createContextCache({ maxEntries: 2 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a");
    cache.set("c", 3);
    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBeNull();
    expect(cache.get("c")).toBe(3);
  });

  it("invalidate removes entries by key prefix", () => {
    const cache = createContextCache();
    cache.set("task1:run1", "v1");
    cache.set("task1:run2", "v2");
    cache.set("task2:run1", "v3");
    cache.invalidate("task1:");
    expect(cache.get("task1:run1")).toBeNull();
    expect(cache.get("task1:run2")).toBeNull();
    expect(cache.get("task2:run1")).toBe("v3");
  });

  it("clear resets stats and contents", () => {
    const cache = createContextCache();
    cache.set("a", 1);
    cache.get("a");
    cache.get("b");
    cache.clear();
    expect(cache.stats()).toEqual({ hits: 0, misses: 0, size: 0 });
  });
});

describe("makeContextCacheKey", () => {
  it("is deterministic for the same inputs", () => {
    const seed = { taskId: "t", agentName: "a", mode: "execute", commentsHash: "c", skillsHash: "s" };
    const k1 = makeContextCacheKey(seed);
    const k2 = makeContextCacheKey(seed);
    expect(k1).toBe(k2);
  });

  it("differs when any contributing hash changes", () => {
    const base = makeContextCacheKey({ taskId: "t", agentName: "a", mode: "execute", commentsHash: "x" });
    const changed = makeContextCacheKey({ taskId: "t", agentName: "a", mode: "execute", commentsHash: "y" });
    expect(base).not.toBe(changed);
  });

  it("returns a 24-char hex string", () => {
    const k = makeContextCacheKey({ taskId: "t", agentName: "a", mode: "review" });
    expect(k).toMatch(/^[0-9a-f]{24}$/);
  });
});

describe("shortHash", () => {
  it("hashes strings deterministically", () => {
    expect(shortHash("hello")).toBe(shortHash("hello"));
    expect(shortHash("hello")).not.toBe(shortHash("world"));
  });

  it("hashes objects via JSON.stringify", () => {
    expect(shortHash({ a: 1 })).toBe(shortHash({ a: 1 }));
  });

  it("returns empty for nullish", () => {
    expect(shortHash(null)).toBe("");
    expect(shortHash(undefined)).toBe("");
  });
});
