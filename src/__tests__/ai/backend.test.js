import { describe, it, expect } from "vitest";
import { backendCapabilities, backendUsesExecenvConfig, backendSupportsSessionResume, BACKEND_CAPABILITIES } from "../../ai/backend.js";

describe("backendCapabilities", () => {
  it("resolves by sdk kind", () => {
    expect(backendCapabilities("claude")).toMatchObject({ kind: "claude", runtime: "sdk" });
    expect(backendCapabilities("pi")).toMatchObject({ kind: "pi", runtime: "pi-agent" });
  });

  it("resolves by parsed model object", () => {
    expect(backendCapabilities({ sdk: "pi", provider: "openai", model: "gpt-5.5" }).kind).toBe("pi");
  });

  it("throws on unknown or reserved sdk", () => {
    expect(() => backendCapabilities("nope")).toThrow();
    expect(() => backendCapabilities("codex")).toThrow(/unknown provider sdk/i);
    expect(() => backendCapabilities("claude-code")).toThrow(/unknown provider sdk/i);
  });
});

describe("backendUsesExecenvConfig", () => {
  it("pi and SDK backends do not need native runtime config files", () => {
    expect(backendUsesExecenvConfig("claude")).toBe(false);
    expect(backendUsesExecenvConfig("pi")).toBe(false);
  });
});

describe("backendSupportsSessionResume", () => {
  it("does not claim session resume for SDK-backed providers", () => {
    expect(backendSupportsSessionResume("claude")).toBe(false);
    expect(backendSupportsSessionResume("pi")).toBe(false);
  });
});

describe("BACKEND_CAPABILITIES", () => {
  it("covers every PROVIDER_KIND", () => {
    expect(Object.keys(BACKEND_CAPABILITIES).sort()).toEqual(
      ["claude", "pi"],
    );
  });
});
