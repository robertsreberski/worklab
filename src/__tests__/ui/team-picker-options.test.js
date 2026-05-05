import { describe, expect, it } from "vitest";
import { teamPickerOptions } from "../../ui/src/components/TeamPicker.jsx";

describe("teamPickerOptions", () => {
  const teams = [
    { id: "team-active", slug: "active-team", name: "Active Team", status: "active", member_count: 3 },
    { id: "team-archived", slug: "archived-team", name: "Archived Team", status: "archived", member_count: 1 },
  ];

  it("includes a clear option and active teams", () => {
    const options = teamPickerOptions({ teams, value: null, clearLabel: "Project default" });

    expect(options.map((option) => option.value)).toEqual(["__none__", "team-active"]);
    expect(options[0]).toMatchObject({ label: "Project default" });
    expect(options.find((option) => option.value === "team-active")).toMatchObject({
      label: "Active Team",
      description: expect.stringContaining("active-team"),
    });
  });

  it("keeps the current archived team visible but unselectable", () => {
    const options = teamPickerOptions({ teams, value: "team-archived", clearLabel: "No team" });

    expect(options.map((option) => option.value)).toEqual(["__none__", "team-active", "team-archived"]);
    expect(options[0]).toMatchObject({ label: "No team" });
    expect(options.find((option) => option.value === "team-archived")).toMatchObject({
      disabled: true,
      description: expect.stringContaining("archived"),
    });
  });
});
