import express from "express";
import supertest from "supertest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mountStaticUi } from "../../coordinator/static-ui.js";

describe("static UI mounting", () => {
  it("uses the missing UI fallback when repoRoot is omitted", async () => {
    const app = express();

    expect(() => mountStaticUi(app)).not.toThrow();

    const res = await supertest(app).get("/").expect(503);
    expect(res.text).toContain("UI not built");
  });

  describe("cache headers", () => {
    let tempRoot;

    beforeEach(() => {
      tempRoot = mkdtempSync(join(tmpdir(), "worklab-static-ui-"));
      const dist = join(tempRoot, "src/ui/dist");
      mkdirSync(join(dist, "assets"), { recursive: true });
      writeFileSync(join(dist, "index.html"), "<html></html>");
      writeFileSync(join(dist, "sw.js"), "// sw");
      writeFileSync(join(dist, "assets", "main-abc.js"), "// hashed");
      writeFileSync(join(dist, "manifest.webmanifest"), "{}");
    });

    afterEach(() => {
      rmSync(tempRoot, { recursive: true, force: true });
    });

    it("serves hashed assets with immutable long-lived caching", async () => {
      const app = express();
      mountStaticUi(app, { repoRoot: tempRoot });
      const res = await supertest(app).get("/assets/main-abc.js").expect(200);
      expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    });

    it("serves the service worker and index.html with no-cache", async () => {
      const app = express();
      mountStaticUi(app, { repoRoot: tempRoot });
      const swRes = await supertest(app).get("/sw.js").expect(200);
      expect(swRes.headers["cache-control"]).toBe("no-cache");
      const fallbackRes = await supertest(app).get("/some/route").expect(200);
      expect(fallbackRes.headers["cache-control"]).toBe("no-cache");
    });

    it("serves the manifest and icons with a short cache", async () => {
      const app = express();
      mountStaticUi(app, { repoRoot: tempRoot });
      const res = await supertest(app).get("/manifest.webmanifest").expect(200);
      expect(res.headers["cache-control"]).toBe("public, max-age=86400");
    });
  });
});
