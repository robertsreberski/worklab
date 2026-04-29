import { describe, expect, it } from "vitest";
import { normalizeKbEntry, normalizeKbFormEntry } from "../../ui/src/routes/kb-entry-form.js";

describe("normalizeKbFormEntry", () => {
  it("flattens nested KB API responses for the edit form", () => {
    expect(normalizeKbFormEntry({
      meta: {
        slug: "welcome",
        title: "Welcome",
        category: "guide",
        tags: ["intro", "setup"],
        pinned: true,
      },
      body: "# Hello",
    })).toEqual({
      slug: "welcome",
      title: "Welcome",
      category: "guide",
      tags: "intro, setup",
      pinned: true,
      body: "# Hello",
    });
  });

  it("preserves compatibility with legacy flat KB entry payloads", () => {
    expect(normalizeKbFormEntry({
      slug: "legacy",
      title: "Legacy",
      category: null,
      tags: ["ops"],
      pinned: false,
      body: "body",
    })).toEqual({
      slug: "legacy",
      title: "Legacy",
      category: "",
      tags: "ops",
      pinned: false,
      body: "body",
    });
  });

  it("normalizes nested KB API responses for read views", () => {
    expect(normalizeKbEntry({
      meta: {
        slug: "welcome",
        title: "Welcome",
        category: null,
        tags: ["intro", "setup"],
        pinned: true,
        author: "human",
        created_at: "2026-04-24T12:00:00Z",
        updated_at: "2026-04-25T12:00:00Z",
      },
      body: "# Hello",
    })).toEqual({
      slug: "welcome",
      title: "Welcome",
      category: "",
      tags: ["intro", "setup"],
      pinned: true,
      author: "human",
      created_at: "2026-04-24T12:00:00Z",
      updated_at: "2026-04-25T12:00:00Z",
      body: "# Hello",
    });
  });
});
