import { describe, expect, it } from "vitest";
import {
  createCoordinatorClaim,
  parseCoordinatorClaim,
  parseCoordinatorPid,
} from "../../core/process/index.js";

describe("coordinator PID claims", () => {
  it("keeps the first line numeric for every CLI PID reader", () => {
    const claim = createCoordinatorClaim(12345, "00000000-0000-4000-8000-000000000001");

    expect(claim).toBe("12345\nv2:00000000-0000-4000-8000-000000000001");
    expect(parseCoordinatorPid(claim)).toBe(12345);
    expect(parseCoordinatorClaim(claim)).toEqual({
      format: "v2",
      pid: 12345,
      incarnation: "00000000-0000-4000-8000-000000000001",
    });
  });

  it("distinguishes legacy numeric files from malformed claims", () => {
    expect(parseCoordinatorClaim("12345\n")).toEqual({ format: "legacy", pid: 12345 });
    expect(parseCoordinatorClaim("12345\nother:claim")).toEqual({ format: "invalid", pid: 12345 });
    expect(parseCoordinatorClaim("not-a-pid\nv2:token")).toEqual({ format: "invalid", pid: null });
  });
});
