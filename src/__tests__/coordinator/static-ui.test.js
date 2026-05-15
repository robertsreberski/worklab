import express from "express";
import supertest from "supertest";
import { describe, expect, it } from "vitest";
import { mountStaticUi } from "../../coordinator/static-ui.js";

describe("static UI mounting", () => {
  it("uses the missing UI fallback when repoRoot is omitted", async () => {
    const app = express();

    expect(() => mountStaticUi(app)).not.toThrow();

    const res = await supertest(app).get("/").expect(503);
    expect(res.text).toContain("UI not built");
  });
});
