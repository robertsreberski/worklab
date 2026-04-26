import { describe, expect, it } from "vitest";
import { applyConfigArgs, argValue, hasFlag } from "../../cli/args.js";

describe("CLI args", () => {
  it("reads flag values from separated and equals forms", () => {
    expect(argValue(["--port", "9000"], "--port")).toBe("9000");
    expect(argValue(["--host=0.0.0.0"], "--host")).toBe("0.0.0.0");
    expect(hasFlag(["--no-build"], "--no-build")).toBe(true);
  });

  it("applies config flags to the target env", () => {
    const env = {};
    applyConfigArgs([
      "--port", "9000",
      "--host", "0.0.0.0",
      "--data-dir=/tmp/worklab",
      "--workspace", "/tmp/workspace",
    ], env);

    expect(env).toMatchObject({
      WORKLAB_PORT: "9000",
      WORKLAB_HOST: "0.0.0.0",
      WORKLAB_DATA_DIR: "/tmp/worklab",
      WORKLAB_WORKSPACE: "/tmp/workspace",
    });
  });

  it("rejects invalid port values", () => {
    expect(() => applyConfigArgs(["--port", "abc"], {})).toThrow(/--port/);
    expect(() => applyConfigArgs(["--port=70000"], {})).toThrow(/--port/);
  });
});
