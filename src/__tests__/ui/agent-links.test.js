import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { agentHref, splitAgentReferences } from "../../ui/src/lib/agentLinks.js";

const agentLinkSource = readFileSync(
  resolve(import.meta.dirname, "../../ui/src/components/AgentLink.jsx"),
  "utf8",
);

const agents = [
  { name: "automattic-sandbox-engineer", display_name: "Automattic Sandbox Engineer" },
  { name: "code-reviewer", display_name: "Code Reviewer" },
];

describe("agent link helpers", () => {
  it("builds agent edit links from slugs", () => {
    expect(agentHref("automattic-sandbox-engineer")).toBe("#/library/agents/automattic-sandbox-engineer");
  });

  it("replaces known agent slugs with display-name link parts", () => {
    expect(splitAgentReferences(
      "Daily budget for automattic-sandbox-engineer reached ($59.7195 of $50.00).",
      agents,
    )).toEqual([
      "Daily budget for ",
      {
        type: "agent",
        name: "automattic-sandbox-engineer",
        label: "Automattic Sandbox Engineer",
        href: "#/library/agents/automattic-sandbox-engineer",
      },
      " reached ($59.7195 of $50.00).",
    ]);
  });

  it("replaces known agent display names with links", () => {
    expect(splitAgentReferences(
      "Daily budget for Automattic Sandbox Engineer reached ($59.7195 of $50.00).",
      agents,
    )).toEqual([
      "Daily budget for ",
      {
        type: "agent",
        name: "automattic-sandbox-engineer",
        label: "Automattic Sandbox Engineer",
        href: "#/library/agents/automattic-sandbox-engineer",
      },
      " reached ($59.7195 of $50.00).",
    ]);
  });

  it("does not replace partial slug matches", () => {
    expect(splitAgentReferences("xautomattic-sandbox-engineer is not a reference", agents)).toEqual([
      "xautomattic-sandbox-engineer is not a reference",
    ]);
  });

  it("renders text references through the shared entity badge", () => {
    expect(agentLinkSource).toContain("EntityBadge");
    expect(agentLinkSource).toContain('kind="agent"');
  });
});
