import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderMarkdown } from "../../ui/src/components/Markdown.jsx";

const repoRoot = resolve(import.meta.dirname, "../../..");
const stylesPath = resolve(repoRoot, "src/ui/src/styles.css");

function declarationsForSelector(css, selector) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((match) => match[1]
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split(",")
      .map((item) => item.trim())
      .includes(selector))
    .map((match) => match[2])
    .join("\n");
}

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
    expect(html).toContain('title="Agent: Triager Bot"');
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
    expect(html).toContain('<span class="badge-token-label">Unknown Agent</span>');
    expect(html).not.toContain('<span class="badge-token-label">agent/missing</span>');
    expect(html).toContain('title="Mention target no longer exists"');
  });

  it("renders a generic label instead of the bare token id when no mentions map is provided", () => {
    const html = renderMarkdown("@agent/triager");
    expect(html).toContain("entity-badge--agent");
    expect(html).toContain('<span class="badge-token-label">Unknown Agent</span>');
    expect(html).not.toContain('<span class="badge-token-label">agent/triager</span>');
  });

  it("renders knowledge mentions with the book icon instead of a K glyph", () => {
    const html = renderMarkdown("See @kb/runbook.", {
      mentions: {
        "@kb/runbook": {
          token: "@kb/runbook",
          type: "kb",
          label: "Operations Runbook",
          href: "#/library/knowledge/runbook",
          exists: true,
        },
      },
    });

    expect(html).toContain("entity-badge--kb");
    expect(html).toContain('<span class="badge-token-leading" aria-hidden="true">');
    expect(html).toContain("<svg");
    expect(html).not.toContain('<span class="badge-token-glyph" aria-hidden="true">K</span>');
    expect(html).toContain('<span class="badge-token-label">Operations Runbook</span>');
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
  it("renders internal Worklab entity links as mention-style badges", () => {
    const html = renderMarkdown([
      "[Triager](#/library/agents/triager)",
      "[Knowledge Entry](#/library/knowledge/entry-1)",
      "[Skill](#/library/skills/ui-polish)",
      "[Team](#/library/teams/core-platform)",
      "[Project](#/projects/project-1)",
      "[Task](#/tasks/task-1)",
      "[Goal](#/goals/goal-1)",
      "[Latest Run](#/tasks/task-1?run=run-1)",
    ].join(" "));

    expect(html).toContain('entity-badge--agent" data-kind="agent" href="#/library/agents/triager"');
    expect(html).toContain('<span class="badge-token-label">Unknown Agent</span>');
    expect(html).toContain('entity-badge--kb" data-kind="kb" href="#/library/knowledge/entry-1"');
    expect(html).toContain('<span class="badge-token-label">Unknown Knowledge</span>');
    expect(html).toContain('entity-badge--skill" data-kind="skill" href="#/library/skills/ui-polish"');
    expect(html).toContain('<span class="badge-token-label">Unknown Skill</span>');
    expect(html).toContain('entity-badge--team" data-kind="team" href="#/library/teams/core-platform"');
    expect(html).toContain('<span class="badge-token-label">Unknown Team</span>');
    expect(html).toContain('entity-badge--project" data-kind="project" href="#/projects/project-1"');
    expect(html).toContain('<span class="badge-token-label">Unknown Project</span>');
    expect(html).toContain('entity-badge--task" data-kind="task" href="#/tasks/task-1"');
    expect(html).toContain('<span class="badge-token-label">Unknown Task</span>');
    expect(html).toContain('entity-badge--goal" data-kind="goal" href="#/goals/goal-1"');
    expect(html).toContain('<span class="badge-token-label">Unknown Goal</span>');
    expect(html).toContain('entity-badge--run" data-kind="run" href="#/tasks/task-1?run=run-1"');
    expect(html).toContain('<span class="badge-token-label">Unknown Run</span>');
  });

  it("uses resolved entity labels for internal link badges instead of anchor text", () => {
    const html = renderMarkdown("[Wrong label](#/library/knowledge/auth-flow) [Bad](#/library/agents/triager)", {
      mentions: {
        "#/library/knowledge/auth-flow": {
          type: "kb",
          label: "Authentication Flow",
          href: "#/library/knowledge/auth-flow",
          exists: true,
        },
        "#/library/agents/triager": {
          type: "agent",
          label: "Triager Bot",
          href: "#/library/agents/triager",
          exists: true,
        },
      },
    });

    expect(html).toContain('<span class="badge-token-label">Authentication Flow</span>');
    expect(html).toContain('<span class="badge-token-label">Triager Bot</span>');
    expect(html).not.toContain("Wrong label");
    expect(html).not.toContain(">Bad<");
  });

  it("falls back to generic labels for internal link badges without a sidecar", () => {
    const html = renderMarkdown("[Wrong label](#/library/agents/review-agent)");

    expect(html).toContain('<span class="badge-token-label">Unknown Agent</span>');
    expect(html).not.toContain('<span class="badge-token-label">Review Agent</span>');
    expect(html).not.toContain("Wrong label");
  });

  it("keeps document entity badges aligned and colored as badges instead of links", () => {
    const css = readFileSync(stylesPath, "utf8");
    const docBadgeRule = declarationsForSelector(css, ".doc-content a.badge-token");
    const markdownBadgeRule = declarationsForSelector(css, ".markdown a.badge-token");

    expect(docBadgeRule).toContain("color: var(--badge-token-tone)");
    expect(docBadgeRule).toContain("transform: translateY(-2px)");
    expect(markdownBadgeRule).toContain("color: var(--badge-token-tone)");
  });

  it("keeps non-entity hash links as normal anchors", () => {
    const html = renderMarkdown("[Jump](#main)");

    expect(html).toContain('<a href="#main">Jump</a>');
    expect(html).not.toContain("entity-badge");
  });

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
