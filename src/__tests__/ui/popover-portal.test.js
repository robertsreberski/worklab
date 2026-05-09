import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const portalCalls = [];

vi.mock("preact/compat", () => ({
  createPortal: (children, container) => {
    portalCalls.push({ children, container });
    return { __portal: true, children, container };
  },
}));

const { PopoverPortal } = await import("../../ui/src/components/primitives/PopoverPortal.jsx");

describe("PopoverPortal", () => {
  beforeEach(() => {
    portalCalls.length = 0;
  });

  afterEach(() => {
    // Restore any document mutation; the SSR test may delete it.
    if (typeof globalThis.document === "undefined") {
      globalThis.document = originalDocument;
    }
  });

  // jsdom isn't loaded in this Vitest config (env: "node"); fake document.body
  // for the happy-path test.
  const originalDocument = globalThis.document;
  const fakeBody = { __body: true };
  globalThis.document = { body: fakeBody };

  it("renders children into document.body via createPortal", () => {
    const result = PopoverPortal({ children: { type: "div", props: { children: "hi" } } });
    expect(portalCalls).toHaveLength(1);
    expect(portalCalls[0].container).toBe(fakeBody);
    expect(result).toEqual(expect.objectContaining({ __portal: true, container: fakeBody }));
  });

  it("returns null when document is undefined (SSR)", () => {
    const saved = globalThis.document;
    delete globalThis.document;
    try {
      const result = PopoverPortal({ children: { type: "div", props: {} } });
      expect(result).toBeNull();
      expect(portalCalls).toHaveLength(0);
    } finally {
      globalThis.document = saved;
    }
  });
});
