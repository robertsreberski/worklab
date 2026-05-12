import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../../ui/src/components/Markdown.jsx";

describe("renderMarkdown mentions", () => {
  it("renders a known agent mention as a clickable badge with the resolved label", () => {
    const html = renderMarkdown("Hey @agent/triager handle this.", {
      mentions: {
        "@agent/triager": {
          token: "@agent/triager",
          type: "agent",
          label: "Triager Bot",
          href: "#/library/agents/triager",
          exists: true,
        },
      },
    });
    expect(html).toContain('<a class="badge-token badge-token-sm entity-badge entity-badge--agent" data-kind="agent" href="#/library/agents/triager"');
    expect(html).toContain('<span class="badge-token-glyph" aria-hidden="true">A</span>');
    expect(html).toContain('<span class="badge-token-label">Triager Bot</span>');
    expect(html).toContain('title="@agent/triager"');
  });

  it("renders a known team mention with an icon instead of the old letter glyph", () => {
    const html = renderMarkdown("Route to @team/routing.", {
      mentions: {
        "@team/routing": {
          token: "@team/routing",
          type: "team",
          label: "Routing Team",
          href: "#/library/teams/routing",
          exists: true,
        },
      },
    });

    expect(html).toContain("entity-badge--team");
    expect(html).toContain('<span class="badge-token-leading" aria-hidden="true">');
    expect(html).toContain("<svg");
    expect(html).not.toContain('<span class="badge-token-glyph" aria-hidden="true">M</span>');
    expect(html).toContain('<span class="badge-token-label">Routing Team</span>');
  });

  it("renders unknown / deleted mentions as a struck-through chip", () => {
    const html = renderMarkdown("ping @agent/missing", { mentions: {} });
    expect(html).toContain("entity-badge--missing");
    expect(html).toContain("agent/missing");
    expect(html).toContain('title="Mention target no longer exists"');
  });

  it("renders the bare token id as a fallback when no mentions map is provided", () => {
    const html = renderMarkdown("@agent/triager");
    expect(html).toContain("entity-badge--agent");
    expect(html).toContain("agent/triager");
  });

  it("does not produce a mention badge for email-style @ in prose", () => {
    const html = renderMarkdown("Email admin@agent/x for help.");
    expect(html).not.toContain("entity-badge");
  });

  it("renders mentions inside list items", () => {
    const html = renderMarkdown("- assign @agent/triager", {
      mentions: {
        "@agent/triager": {
          token: "@agent/triager",
          type: "agent",
          label: "Triager",
          href: "#/library/agents/triager",
          exists: true,
        },
      },
    });
    expect(html).toMatch(/<ul><li>assign <a class="badge-token badge-token-sm entity-badge entity-badge--agent"/);
  });
});

describe("renderMarkdown", () => {
  it("renders headings, emphasis, lists, and tables used in task comments", () => {
    const html = renderMarkdown("# Heading\n\n**bold** text\n\n- one\n- two\n\n| A | B |\n| --- | --- |\n| 1 | 2 |");

    expect(html).toContain("<h1>Heading</h1>");
    expect(html).toContain("<strong>bold</strong> text");
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(html).toContain('<table class="doc-table">');
    expect(html).toContain("<td>2</td>");
  });

  it("sanitizes unsafe link schemes", () => {
    const html = renderMarkdown("[click me](javascript:alert(1))");

    expect(html).toContain('href="#"');
    expect(html).toContain(">click me</a>");
  });

  it("auto-links bare URLs in task comments", () => {
    const html = renderMarkdown("See https://example.com/path?a=1&b=2.");
    const link = '<a href="https://example.com/path?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">https://example.com/path?a=1&amp;b=2</a>.';

    expect(html).toContain(link);
  });

  it("auto-links www URLs with an https target", () => {
    const html = renderMarkdown("Docs: www.example.com/help");
    const link = '<a href="https://www.example.com/help" target="_blank" rel="noopener noreferrer">www.example.com/help</a>';

    expect(html).toContain(link);
  });

  it("does not auto-link URLs inside inline code or existing markdown links", () => {
    const html = renderMarkdown("Use `https://example.com/code` or [docs](https://example.com/docs).");

    expect(html).toContain("<code>https://example.com/code</code>");
    expect(html).toContain('<a href="https://example.com/docs" target="_blank" rel="noopener noreferrer">docs</a>');
    expect(html.match(/<a /g)).toHaveLength(1);
  });
});
