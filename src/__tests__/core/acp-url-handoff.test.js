import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createAcpUrlPublicRequest,
  createAcpUrlHandoffStore,
  inspectAcpUrlHandoff,
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

  it("canonicalizes redirects and exposes only a fixed host-owned public marker", () => {
    const original = "https://例え.テスト:443/続行/PRIVATE_PATH?PRIVATE%20KEY=PRIVATE%20QUERY&KEY_ONLY_PRIVATE#FRAGMENT_KEY_PRIVATE=PRIVATE%20FRAGMENT&FRAGMENT_ONLY_PRIVATE";
    const inspected = inspectAcpUrlHandoff(original);

    expect(inspected.url).toBe(
      "https://xn--r8jz45g.xn--zckzah/%E7%B6%9A%E8%A1%8C/PRIVATE_PATH?PRIVATE%20KEY=PRIVATE%20QUERY&KEY_ONLY_PRIVATE#FRAGMENT_KEY_PRIVATE=PRIVATE%20FRAGMENT&FRAGMENT_ONLY_PRIVATE",
    );
    expect(inspected.privateValues).toEqual(expect.arrayContaining([
      original,
      inspected.url,
      "例え",
      "テスト",
      "xn--r8jz45g",
      "xn--zckzah",
      "443",
      "PRIVATE_PATH",
      "PRIVATE%20KEY",
      "PRIVATE KEY",
      "KEY_ONLY_PRIVATE",
      "PRIVATE%20QUERY",
      "PRIVATE QUERY",
      "PRIVATE%20FRAGMENT",
      "PRIVATE FRAGMENT",
      "FRAGMENT_KEY_PRIVATE",
      "FRAGMENT_ONLY_PRIVATE",
    ]));
    expect(createAcpUrlPublicRequest(original)).toEqual({
      mode: "url",
      message: "Continue in your browser.",
      urlAvailable: true,
    });
    expect(JSON.stringify(createAcpUrlPublicRequest(original)))
      .not.toMatch(/xn--|PRIVATE|KEY_ONLY|FRAGMENT/u);
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

  it("retains the URL when redirect header construction fails", () => {
    const store = createAcpUrlHandoffStore();
    const url = "https://example.test/private?state=retry";
    expect(store.retain({ ...owner, url })).toBe(true);

    expect(() => store.consumeWith(owner, () => {
      throw new Error("header rejected");
    })).toThrow("header rejected");
    expect(store.has(owner)).toBe(true);
    expect(store.consumeWith(owner, (value) => value)).toEqual({
      consumed: true,
      value: url,
    });
    expect(store.has(owner)).toBe(false);
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
