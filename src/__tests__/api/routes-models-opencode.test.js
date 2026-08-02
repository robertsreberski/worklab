import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestServer } from "../helpers/test-server.js";
import { _resetOpencodeCatalogueCache } from "../../core/opencode-models.js";

const mocks = vi.hoisted(() => ({
  discoverOpencodeProviders: vi.fn(),
}));

vi.mock("@mono-agent/agent-runtime/ai/providers/opencode-discovery.js", () => ({
  discoverOpencodeProviders: mocks.discoverOpencodeProviders,
}));

// Force a PATH with no `opencode` binary so the route resolves deterministically
// without booting a real opencode server.
let savedPath;
let emptyDir;
let dataDir;

beforeEach(() => {
  savedPath = process.env.PATH;
  emptyDir = mkdtempSync(join(tmpdir(), "worklab-no-opencode-"));
  dataDir = mkdtempSync(join(tmpdir(), "worklab-opencode-data-"));
  process.env.PATH = emptyDir;
  mocks.discoverOpencodeProviders.mockReset();
  _resetOpencodeCatalogueCache();
});

afterEach(() => {
  process.env.PATH = savedPath;
  rmSync(emptyDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
  _resetOpencodeCatalogueCache();
});

describe("GET /api/models/opencode", () => {
  it("reports unavailable with no groups when the opencode binary is absent", async () => {
    const { agent } = makeTestServer({ dataDir });
    const res = await agent.get("/api/models/opencode").expect(200);
    expect(res.body).toMatchObject({ available: false, groups: [] });
    expect(res.body.reason).toMatch(/opencode/i);
  });

  it("rejects cross-site refreshes before OpenCode provider discovery can spawn", async () => {
    writeFileSync(join(emptyDir, "opencode"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    mocks.discoverOpencodeProviders.mockResolvedValue([{
      providerID: "test-provider",
      name: "Test Provider",
      models: [{
        id: "test-model",
        name: "Test Model",
        reasoning: false,
        toolCall: true,
        vision: false,
        status: "active",
      }],
    }]);
    const { agent, rawAgent } = makeTestServer({ dataDir });

    for (const method of ["get", "head"]) {
      await rawAgent[method]("/api/models/opencode?refresh=1")
        .set("origin", "https://evil.example")
        .set("sec-fetch-site", "cross-site")
        .expect(403);
    }
    expect(mocks.discoverOpencodeProviders).not.toHaveBeenCalled();

    const response = await agent.get("/api/models/opencode?refresh=1").expect(200);
    expect(response.body).toMatchObject({ available: true });
    expect(mocks.discoverOpencodeProviders).toHaveBeenCalledTimes(1);
  });
});
