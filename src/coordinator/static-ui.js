import express from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";

export function mountStaticUi(app, { repoRoot } = {}) {
  const uiDist = join(repoRoot, "src/ui/dist");
  if (existsSync(uiDist)) {
    app.use(express.static(uiDist));
    app.get("*", (_req, res) => res.sendFile(join(uiDist, "index.html")));
  } else {
    app.get("/", (_req, res) => res.status(503).send("UI not built. Run: npm start or npm run build:ui"));
  }
}
