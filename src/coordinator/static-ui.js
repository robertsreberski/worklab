import express from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";

function setStaticCacheHeaders(res, path) {
  // Hashed Vite output is content-addressed; safe to mark immutable for a year
  // so the service worker and browser cache it without ever revalidating.
  if (path.includes(`${"/"}assets${"/"}`)) {
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    return;
  }
  // Service worker and shell HTML must revalidate so updates ship quickly.
  if (path.endsWith("/sw.js") || path.endsWith("/sw.mjs") || path.endsWith("/index.html")) {
    res.set("Cache-Control", "no-cache");
    return;
  }
  // Icons, manifest, etc.: short cache; they change rarely but should not pin.
  res.set("Cache-Control", "public, max-age=86400");
}

export function mountStaticUi(app, { repoRoot } = {}) {
  const uiDist = repoRoot ? join(repoRoot, "src/ui/dist") : null;
  if (uiDist && existsSync(uiDist)) {
    app.use(express.static(uiDist, { setHeaders: setStaticCacheHeaders }));
    app.get("*", (_req, res) => {
      res.set("Cache-Control", "no-cache");
      res.sendFile(join(uiDist, "index.html"));
    });
  } else {
    app.get("/", (_req, res) => res.status(503).send("UI not built. Run: npm start or npm run build:ui"));
  }
}
