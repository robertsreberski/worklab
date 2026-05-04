import { describe, expect, it } from "vitest";
import {
  instructionsCoachState,
} from "../../ui/src/routes/TaskEdit.jsx";

describe("instructionsCoachState", () => {
  it("treats an empty value as optional guidance", () => {
    const state = instructionsCoachState("");
    expect(state.length).toBe(0);
    expect(state.tone).toBe("instructions-coach-empty");
    expect(state.label).not.toMatch(/need|required|minimum|save/i);
  });

  it("counts whitespace as empty", () => {
    expect(instructionsCoachState("   \n  \t").tone).toBe("instructions-coach-empty");
  });

  it("does not warn or error for short instructions", () => {
    const value = "fix the login flow";
    const state = instructionsCoachState(value);
    expect(state.tone).toBe("instructions-coach-good");
    expect(state.label).not.toMatch(/more characters|thin brief|done looks like|verify/i);
  });

  it("keeps the same non-blocking state for longer instructions", () => {
    const value = "x".repeat(205);
    const state = instructionsCoachState(value);
    expect(state.tone).toBe("instructions-coach-good");
    expect(state.label).not.toMatch(/minimum|thin brief/i);
  });
});
