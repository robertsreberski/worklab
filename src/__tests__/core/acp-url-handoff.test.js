import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createAcpUrlHandoffStore,
  normalizeAcpUrlHandoff,
} from "../../core/acp-url-handoff.js";

const owner = {
  interactionId: "interaction-1",
  ownerKind: "operation",
  ownerId: "operation-1",
  profileId: "profile-1",
};

describe("ACP URL handoff store", () => {
  afterEach(() => vi.useRealTimers());

  it("validates only bounded credential-free HTTP(S) URLs", () => {
    expect(normalizeAcpUrlHandoff("https://example.test/authorize?state=private#resume"))
      .toBe("https://example.test/authorize?state=private#resume");
    expect(normalizeAcpUrlHandoff("http://localhost:3210/device")).toBe("http://localhost:3210/device");
    expect(normalizeAcpUrlHandoff("https://user:password@example.test/private")).toBeNull();
    expect(normalizeAcpUrlHandoff("javascript:alert(1)")).toBeNull();
    expect(normalizeAcpUrlHandoff("https://example.test/\r\nLocation: https://evil.test")).toBeNull();
    expect(normalizeAcpUrlHandoff(`https://example.test/${"x".repeat(8_200)}`)).toBeNull();
  });

  it("binds a URL to one interaction owner and consumes it exactly once", () => {
    const store = createAcpUrlHandoffStore();
    const url = "https://example.test/authorize?state=private#resume";

    expect(store.retain({ ...owner, url })).toBe(true);
    expect(store.has(owner)).toBe(true);
    expect(store.consume({ ...owner, ownerId: "another-operation" })).toBeNull();
    expect(store.consume(owner)).toBe(url);
    expect(store.consume(owner)).toBeNull();
    expect(store.size).toBe(0);
    store.clear();
  });

  it("fails closed at count and byte limits without evicting a pending URL", () => {
    const store = createAcpUrlHandoffStore({ maxEntries: 1, maxBytes: 1_000 });
    expect(store.retain({ ...owner, url: "https://example.test/one" })).toBe(true);
    expect(store.retain({
      ...owner,
      interactionId: "interaction-2",
      url: "https://example.test/two",
    })).toBe(false);
    expect(store.consume(owner)).toBe("https://example.test/one");
    store.clear();
  });

  it("expires entries and removes every URL owned by a terminal run", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const store = createAcpUrlHandoffStore({ ttlMs: 100 });
    expect(store.retain({
      ...owner,
      ownerKind: "run",
      ownerId: "run-1",
      url: "https://example.test/one?secret=value",
    })).toBe(true);
    vi.advanceTimersByTime(101);
    expect(store.size).toBe(0);

    expect(store.retain({
      ...owner,
      interactionId: "interaction-2",
      ownerKind: "run",
      ownerId: "run-2",
      url: "https://example.test/two",
    })).toBe(true);
    expect(store.removeOwner("run", "run-2")).toBe(1);
    expect(store.size).toBe(0);
    store.clear();
  });
});
