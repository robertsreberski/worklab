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
});
