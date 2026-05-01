import { describe, expect, it } from "vitest";
import { taskStageMeta } from "../../ui/src/components/primitives/StageToken.jsx";

describe("taskStageMeta", () => {
  it("formats unknown stage labels with a capital first letter", () => {
    expect(taskStageMeta("waiting_on_external").label).toBe("Waiting on external");
  });
});
