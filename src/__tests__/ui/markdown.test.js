import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../../ui/src/components/Markdown.jsx";

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
