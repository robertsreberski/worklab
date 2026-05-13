import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderMarkdown } from "../../ui/src/components/Markdown.jsx";
import * as agentLinks from "../../ui/src/lib/agentLinks.js";
import { agentHref, splitAgentReferences } from "../../ui/src/lib/agentLinks.js";

const agentLinkSource = readFileSync(
  resolve(import.meta.dirname, "../../ui/src/components/AgentLink.jsx"),
  "utf8",
);

const agents = [
  { name: "automattic-sandbox-engineer", display_name: "Automattic Sandbox Engineer" },
  { name: "code-reviewer", display_name: "Code Reviewer" },
  { name: "reviewer", display_name: "Reviewer" },
  { name: "wordpress-qa-reviewer", display_name: "WordPress QA Reviewer" },
];

describe("agent link helpers", () => {
  it("builds agent edit links from slugs", () => {
    expect(agentHref("automattic-sandbox-engineer")).toBe("#/library/agents/automattic-sandbox-engineer");
  });

  it("keeps bare agent slugs as plain text", () => {
    expect(splitAgentReferences(
      "Daily budget for automattic-sandbox-engineer reached ($59.7195 of $50.00).",
      agents,
    )).toEqual([
      "Daily budget for automattic-sandbox-engineer reached ($59.7195 of $50.00).",
    ]);
  });

  it("keeps bare agent display names as plain text", () => {
    expect(splitAgentReferences(
      "Daily budget for Automattic Sandbox Engineer reached ($59.7195 of $50.00).",
      agents,
    )).toEqual([
      "Daily budget for Automattic Sandbox Engineer reached ($59.7195 of $50.00).",
    ]);
  });

  it("does not replace partial slug matches", () => {
    expect(splitAgentReferences("xautomattic-sandbox-engineer is not a reference", agents)).toEqual([
      "xautomattic-sandbox-engineer is not a reference",
    ]);
  });

  it("does not link generic role words that match one-word agent names", () => {
    const text = "Auto-run failed: WordPress QA Reviewer cannot review their own execute run; assign a different reviewer or enable allow_self_review on the agent.";
    expect(splitAgentReferences(text, agents)).toEqual([text]);
  });

  it("replaces explicit agent mentions without corrupting the token prefix", () => {
    expect(splitAgentReferences("Ask @agent/reviewer to check this.", agents)).toEqual([
      "Ask ",
      {
        type: "agent",
        name: "reviewer",
        label: "Reviewer",
        href: "#/library/agents/reviewer",
      },
      " to check this.",
    ]);
  });

  it("renders text references through the shared entity badge", () => {
    expect(agentLinkSource).toContain("EntityBadge");
    expect(agentLinkSource).toContain('kind="agent"');
  });

  it("builds mention metadata for generated markdown agent links", () => {
    const markdown = agentLinks.linkAgentReferencesInMarkdown("Ask @agent/code-reviewer to check this.", agents);
    const mentions = agentLinks.agentReferenceMentions?.(agents) || {};
    const html = renderMarkdown(markdown, { mentions });

    expect(html).toContain('entity-badge--agent" data-kind="agent" href="#/library/agents/code-reviewer"');
    expect(html).toContain('<span class="badge-token-label">Code Reviewer</span>');
    expect(html).not.toContain('<span class="badge-token-label">Unknown Agent</span>');
  });
});
