import { describe, expect, it } from "vitest";
import { agentPickerOptions } from "../../ui/src/components/AgentPicker.jsx";

describe("agentPickerOptions", () => {
  const agents = [
    { name: "enabled-owner", display_name: "Enabled Owner", model: "claude:claude-sonnet-4-6", effort: "medium", enabled: true },
    { name: "disabled-owner", display_name: "Disabled Owner", model: "claude:claude-sonnet-4-6", effort: "medium", enabled: false },
    { name: "legacy-disabled", display_name: "Legacy Disabled", model: "claude:claude-sonnet-4-6", effort: "medium", enabled: false },
  ];

  it("omits disabled agents that are not the current assignment", () => {
    const options = agentPickerOptions({ agents, value: null, allowClear: true });

    expect(options.map((option) => option.value)).toEqual(["__unassigned__", "enabled-owner"]);
  });

  it("keeps the current disabled assignment visible but unselectable", () => {
    const options = agentPickerOptions({ agents, value: "disabled-owner", allowClear: true });

    expect(options.map((option) => option.value)).toEqual(["__unassigned__", "enabled-owner", "disabled-owner"]);
    expect(options.find((option) => option.value === "disabled-owner")).toMatchObject({
      disabled: true,
      description: expect.stringContaining("disabled"),
    });
  });
});
