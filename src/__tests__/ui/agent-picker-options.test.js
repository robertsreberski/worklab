import { describe, expect, it } from "vitest";
import { agentAssignmentEligibility, agentPickerOptions } from "../../ui/src/components/AgentPicker.jsx";

function flattened(options) {
  return options.flatMap((option) => option.options || [option]);
}

describe("agentPickerOptions", () => {
  const agents = [
    { name: "enabled-owner", display_name: "Enabled Owner", model: "claude:claude-sonnet-4-6", effort: "medium", enabled: true },
    { name: "disabled-owner", display_name: "Disabled Owner", model: "claude:claude-sonnet-4-6", effort: "medium", enabled: false },
    { name: "legacy-disabled", display_name: "Legacy Disabled", model: "claude:claude-sonnet-4-6", effort: "medium", enabled: false },
  ];

  it("omits disabled agents that are not the current assignment", () => {
    const options = agentPickerOptions({ agents, value: null, allowClear: true });

    expect(flattened(options).map((option) => option.value)).toEqual(["__unassigned__", "enabled-owner"]);
    expect(options.find((option) => option.label === "Local agents")?.options).toHaveLength(1);
  });

  it("keeps the current disabled assignment visible but unselectable", () => {
    const options = agentPickerOptions({ agents, value: "disabled-owner", allowClear: true });

    const flat = flattened(options);
    expect(flat.map((option) => option.value)).toEqual(["__unassigned__", "enabled-owner", "disabled-owner"]);
    expect(flat.find((option) => option.value === "disabled-owner")).toMatchObject({
      disabled: true,
      description: expect.stringContaining("disabled"),
    });
  });

  it("groups external agents and preserves server eligibility reasons", () => {
    const options = agentPickerOptions({
      agents: [
        ...agents,
        { name: "remote-reviewer", display_name: "Remote Reviewer", kind: "external", enabled: true, driver: "mono" },
      ],
      eligibility: { "remote-reviewer": { eligible: false, reason: "Project workspace is outside the agent root" } },
    });
    const external = options.find((option) => option.label === "External agents");

    expect(external.options[0]).toMatchObject({
      value: "remote-reviewer",
      disabled: true,
      description: expect.stringContaining("Project workspace is outside the agent root"),
    });
    expect(external.options[0].description).toContain("ACP");
  });

  it("accepts eligibility embedded in server agent summaries", () => {
    expect(agentAssignmentEligibility({
      name: "remote",
      assignment_eligible: false,
      assignment_disabled_reason: "External agent is offline",
    })).toEqual({ eligible: false, reason: "External agent is offline" });
  });
});
