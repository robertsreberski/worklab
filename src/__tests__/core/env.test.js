import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapWorklabEnv, loadEnvFile } from "../../core/env.js";

describe("env loading", () => {
  const dirs = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  function tmp() {
    const dir = mkdtempSync(join(tmpdir(), "worklab-env-"));
    dirs.push(dir);
    return dir;
  }

  it("loads simple .env values without overriding shell env", () => {
    const dir = tmp();
    const file = join(dir, ".env");
    const env = { EXISTING: "shell" };
    writeFileSync(file, "A=1\nEXISTING=file\nQUOTED=\"hello world\"\n");

    const result = loadEnvFile(file, { env });

    expect(result.loaded).toBe(true);
    expect(env.A).toBe("1");
    expect(env.EXISTING).toBe("shell");
    expect(env.QUOTED).toBe("hello world");
  });

  it("bootstraps from WORKLAB_DATA_DIR/.env", () => {
    const dir = tmp();
    const env = { WORKLAB_DATA_DIR: dir };
    writeFileSync(join(dir, ".env"), "WORKLAB_PORT=9090\n");

    bootstrapWorklabEnv({ env, repoEnvPath: join(dir, "missing.env") });

    expect(env.WORKLAB_PORT).toBe("9090");
  });

  it("bootstraps from the repository .env before the data-dir .env", () => {
    const dir = tmp();
    const repoDir = tmp();
    const repoEnv = join(repoDir, ".env");
    const env = { WORKLAB_DATA_DIR: dir };
    writeFileSync(repoEnv, "WORKLAB_SLACK_BOT_TOKEN=xoxb-test\nWORKLAB_PORT=9000\n");
    writeFileSync(join(dir, ".env"), "WORKLAB_PORT=9090\n");
    bootstrapWorklabEnv({ env, repoEnvPath: repoEnv });

    expect(env.WORKLAB_SLACK_BOT_TOKEN).toBe("xoxb-test");
    expect(env.WORKLAB_PORT).toBe("9000");
  });
});
