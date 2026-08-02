import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authCli } from "../../cli/auth.js";

describe("worklab auth", () => {
  const dirs = [];
  const originalEnv = { ...process.env };

  function tmp(prefix = "worklab-auth-") {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("writes Pi OpenAI Codex OAuth credentials to the active data directory", async () => {
    const root = tmp();
    const dataDir = join(root, "data");
    const authJson = join(dataDir, "auth.json");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(authJson, JSON.stringify({ anthropic: { type: "oauth", accessToken: "old" } }), "utf8");
    const lines = [];

    let seenProviderId = null;
    let seenCallbacks = null;

    const result = await authCli(["pi", "openai-codex", "--data-dir", dataDir], {
      env: { ...originalEnv },
      stdout: (line) => lines.push(line),
      loginPiOAuthImpl: vi.fn(async (providerId, callbacks) => {
        seenProviderId = providerId;
        seenCallbacks = callbacks;
        callbacks.onProgress("waiting for browser");
        callbacks.onAuth({ url: "https://example.test/login", instructions: "follow the prompt" });
        callbacks.onDeviceCode({ userCode: "ABCD-1234", verificationUri: "https://example.test/device" });
        return { refreshToken: "refresh-secret", expiresAt: 123 };
      }),
    });

    expect(seenProviderId).toBe("openai-codex");
    // The runtime façade throws a TypeError before starting provider login
    // unless all four of these are functions, so assert the contract rather
    // than only the happy path.
    for (const name of ["onAuth", "onDeviceCode", "onPrompt", "onSelect"]) {
      expect(typeof seenCallbacks[name]).toBe("function");
    }

    const written = JSON.parse(readFileSync(join(dataDir, "pi-auth.json"), "utf8"));
    expect(written).toEqual({
      anthropic: { type: "oauth", accessToken: "old" },
      "openai-codex": { type: "oauth", refreshToken: "refresh-secret", expiresAt: 123 },
    });
    expect(result).toEqual(expect.objectContaining({
      provider: "openai-codex",
      path: join(dataDir, "pi-auth.json"),
      wrote: true,
    }));
    expect(lines.join("\n")).toContain("pi auth: saved openai-codex credentials");
    expect(lines.join("\n")).not.toContain("refresh-secret");
  });

  it("dry-runs Pi auth without invoking the OAuth provider or writing credentials", async () => {
    const root = tmp();
    const dataDir = join(root, "data");
    const login = vi.fn();
    const lines = [];

    const result = await authCli(["pi", "openai-codex", "--data-dir", dataDir, "--dry-run"], {
      env: { ...originalEnv },
      stdout: (line) => lines.push(line),
      loginPiOAuthImpl: login,
    });

    expect(login).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ provider: "openai-codex", dryRun: true, wrote: false }));
    expect(lines.join("\n")).toContain("[dry-run]");
  });
});
