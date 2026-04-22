import { getIndexStatus, search } from "../core/embeddings.js";

function parseLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 8;
  return Math.max(1, Math.min(Math.trunc(n), 50));
}

export function registerSearchRoutes(app, { db, dataDir }) {
  app.get("/api/search/status", (_req, res) => {
    res.json({ status: getIndexStatus(db) });
  });

  app.get("/api/search", async (req, res, next) => {
    try {
      const q = String(req.query.q || req.query.query || "").trim();
      if (!q) return res.status(400).json({ error: { code: "validation", message: "q is required" } });
      const kind = req.query.kind || "all";
      if (!["all", "kb", "journal", "memory"].includes(kind)) {
        return res.status(400).json({ error: { code: "validation", message: "invalid kind" } });
      }
      const results = await search({
        db,
        dataDir,
        query: q,
        kind,
        agent: req.query.agent || null,
        limit: parseLimit(req.query.limit),
      });
      res.json({ results });
    } catch (err) {
      next(err);
    }
  });
}
