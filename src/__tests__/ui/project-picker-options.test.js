import { describe, expect, it } from "vitest";
import { projectPickerOptions } from "../../ui/src/components/ProjectPicker.jsx";

describe("projectPickerOptions", () => {
  const projects = [
    { id: "project-active", slug: "active-project", name: "Active Project", archived: false, workdir: "/repos/active", worktree_mode: "auto" },
    { id: "project-archived", slug: "archived-project", name: "Archived Project", archived: true, workdir: "/repos/archived", worktree_mode: "required" },
  ];

  it("includes a clear option and active projects", () => {
    const options = projectPickerOptions({ projects, value: null, clearLabel: "No project" });

    expect(options.map((option) => option.value)).toEqual(["", "project-active"]);
    expect(options[0]).toMatchObject({ label: "No project" });
    expect(options.find((option) => option.value === "project-active")).toMatchObject({
      label: "Active Project",
      description: expect.stringContaining("active-project"),
    });
  });

  it("keeps the current archived project visible but unselectable", () => {
    const options = projectPickerOptions({ projects, value: "project-archived", clearLabel: "Global" });

    expect(options.map((option) => option.value)).toEqual(["", "project-active", "project-archived"]);
    expect(options[0]).toMatchObject({ label: "Global" });
    expect(options.find((option) => option.value === "project-archived")).toMatchObject({
      disabled: true,
      description: expect.stringContaining("archived"),
    });
  });
});
