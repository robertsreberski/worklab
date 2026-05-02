import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { taskStageMeta } from "../../ui/src/components/primitives/StageToken.jsx";

const stageTokenSource = readFileSync(
  resolve(import.meta.dirname, "../../ui/src/components/primitives/StageToken.jsx"),
  "utf8",
);

describe("taskStageMeta", () => {
  it("formats unknown stage labels with a capital first letter", () => {
    expect(taskStageMeta("waiting_on_external").label).toBe("Waiting on external");
  });

  it("marks stage tokens as pulsing only when requested", () => {
    expect(stageTokenSource).toMatch(/pulse\s*=\s*false/);
    expect(stageTokenSource).toMatch(/pulse\s*\?\s*"stage-token-pulse"/);
  });
});
