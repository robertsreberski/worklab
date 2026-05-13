import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

function source(path) {
  return readFileSync(`${repoRoot}/${path}`, "utf8");
}

describe("create entity slug UI", () => {
  it("keeps slugs backend-owned on new entity screens", () => {
    const projects = source("src/ui/src/routes/Projects.jsx");
    const teams = source("src/ui/src/routes/library/TeamsTab.jsx");
    const agents = source("src/ui/src/routes/AgentEdit.jsx");
    const skills = source("src/ui/src/routes/SkillEdit.jsx");
    const knowledge = source("src/ui/src/routes/KbEdit.jsx");

    expect(projects).toMatch(/\{!isNew && \(\s*<FormField\s+label="Slug"/s);
    expect(projects).toContain("slug: isNew ? undefined : draft.slug.trim() || undefined");
    expect(projects).not.toContain('value: isNew ? "Generated on create" : draft.slug');

    expect(teams).toMatch(/\{!isNew && \(\s*<FormField\s+label="Slug"/s);
    expect(teams).toContain("slug: isNew ? undefined : draft.slug.trim() || undefined");
    expect(teams).not.toContain('const slugLabel = isNew ? "Slug after create"');

    for (const route of [agents, skills, knowledge]) {
      expect(route).not.toContain("Slug after create");
      expect(route).not.toContain("Generated after create");
    }
  });

  it("uses the path suggestion picker for project workdirs", () => {
    const projects = source("src/ui/src/routes/Projects.jsx");

    expect(projects).toContain('import { PathSuggestInput } from "../components/PathSuggestInput.jsx";');
    expect(projects).toContain("<PathSuggestInput");
    expect(projects).toContain("preferAbsoluteSelection");
    expect(projects).not.toContain("<Input value={draft.workdir}");
  });
});
