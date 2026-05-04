import { describe, expect, it } from "vitest";
import {
  INSTRUCTIONS_HARD_MIN,
  INSTRUCTIONS_SOFT_MIN,
  instructionsCoachState,
} from "../../ui/src/routes/TaskEdit.jsx";

describe("instructionsCoachState", () => {
  it("flags an empty value with the API's hard minimum", () => {
    const state = instructionsCoachState("");
    expect(state.length).toBe(0);
    expect(state.tone).toBe("instructions-coach-empty");
    expect(state.label).toContain(`${INSTRUCTIONS_HARD_MIN}`);
  });

  it("counts whitespace as empty", () => {
    expect(instructionsCoachState("   \n  \t").tone).toBe("instructions-coach-empty");
  });

  it("returns an error tone with the remaining-chars hint when below the hard min", () => {
    const value = "fix the login flow";
    const state = instructionsCoachState(value);
    expect(state.tone).toBe("instructions-coach-error");
    expect(state.label).toContain(`${INSTRUCTIONS_HARD_MIN - value.length} more characters needed`);
  });

  it("returns a warning tone between the hard floor and the soft minimum", () => {
    const value = "x".repeat(INSTRUCTIONS_HARD_MIN + 10);
    const state = instructionsCoachState(value);
    expect(state.tone).toBe("instructions-coach-warn");
    expect(state.label).toContain("Thin brief");
  });

  it("returns the good tone past the soft minimum", () => {
    const value = "x".repeat(INSTRUCTIONS_SOFT_MIN + 5);
    const state = instructionsCoachState(value);
    expect(state.tone).toBe("instructions-coach-good");
    expect(state.label).toMatch(/agent has enough/);
  });
});
