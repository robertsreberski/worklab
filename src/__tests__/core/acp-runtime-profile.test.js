import { describe, expect, it, vi } from "vitest";

import {
  createMonoAcpDiscoveryControls,
  createWorklabAcpProfileResolver,
  resolveExecutable,
} from "../../core/acp-runtime-profile.js";
import { createAcpProfile } from "../../core/acp-profiles.js";
import { makeTestDb } from "../helpers/test-db.js";

const PROFILE_ID = "11111111-1111-4111-8111-111111111111";

function createGeneric(db, overrides = {}) {
  return createAcpProfile({
    db,
    input: {
      agentName: "external",
      displayName: "External",
      command: process.execPath,
      cwd: "/tmp",
      envKeys: ["TEST_ACP_TOKEN"],
      ...overrides,
    },
    id: PROFILE_ID,
  });
}

describe("Worklab ACP runtime profiles", () => {
  it("resolves only named environment values and enables interaction capabilities", async () => {
    const db = makeTestDb();
    try {
      createGeneric(db);
      const resolveProfile = createWorklabAcpProfileResolver({
        db,
        env: { TEST_ACP_TOKEN: "private", UNLISTED_SECRET: "no" },
      });
      const descriptor = await resolveProfile(PROFILE_ID);
      expect(descriptor.env).toEqual({ TEST_ACP_TOKEN: "private" });
      expect(descriptor.env).not.toHaveProperty("UNLISTED_SECRET");
      expect(descriptor.capabilityPolicy).toMatchObject({
        terminal: false,
        elicitation: { form: true, url: true },
        mcp: { stdio: false },
      });
      expect(descriptor.process).toMatchObject({ requestTimeoutMs: 0, maxLineBytes: 16 * 1024 * 1024 });
    } finally {
      db.close();
    }
  });

  it("fails safely for missing environment or unsupported client capabilities", async () => {
    const missingDb = makeTestDb();
    try {
      createGeneric(missingDb);
      await expect(createWorklabAcpProfileResolver({ db: missingDb, env: {} })(PROFILE_ID))
        .rejects.toMatchObject({ code: "environment_missing" });
    } finally {
      missingDb.close();
    }

    const unsupportedDb = makeTestDb();
    try {
      createGeneric(unsupportedDb, {
        envKeys: [],
        permissionsPolicy: { filesystem: true, terminal: false, network: false, mcp: false },
      });
      await expect(createWorklabAcpProfileResolver({ db: unsupportedDb, env: {} })(PROFILE_ID))
        .rejects.toMatchObject({ code: "capability_unsupported" });
    } finally {
      unsupportedDb.close();
    }
  });

  it("builds exact mono bridge argv from sanitized discovery", async () => {
    const descriptor = {
      sourceId: "personal",
      compatible: true,
      workspace: { path: "/tmp", owner: "agent" },
    };
    const discover = vi.fn().mockResolvedValue({ sources: [descriptor] });
    const controls = createMonoAcpDiscoveryControls({
      command: process.execPath,
      env: { PATH: process.env.PATH, HOME: "/tmp/home" },
      discover,
    });
    await expect(controls.resolveMonoSource({ sourceId: "personal" })).resolves.toEqual({
      descriptor,
      command: resolveExecutable(process.execPath),
      args: ["bridge", "acp", "--source-id", "personal"],
      envKeys: ["HOME", "PATH"],
    });
    expect(discover).toHaveBeenCalledWith(expect.objectContaining({ command: resolveExecutable(process.execPath) }));
  });
});
