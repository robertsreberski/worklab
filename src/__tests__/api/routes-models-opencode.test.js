import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestServer } from "../helpers/test-server.js";
import { _resetOpencodeCatalogueCache } from "../../core/opencode-models.js";

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
});
