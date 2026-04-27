import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../ui/src/lib/api.js";

describe("skill import API helper", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("uploads skill zips as raw bodies with an encoded filename header", async () => {
    const file = { name: "Research Skill.zip", type: "application/zip" };
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ skill: { name: "research-skill" } }),
    }));

    const result = await api.importSkillZip(file);

    expect(result.skill.name).toBe("research-skill");
    expect(global.fetch).toHaveBeenCalledWith("/api/skills/import", {
      method: "POST",
      headers: {
        "Content-Type": "application/zip",
        "X-Skill-Filename": "Research%20Skill.zip",
      },
      body: file,
    });
  });
});
