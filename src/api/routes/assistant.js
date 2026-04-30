import { createWorklabAssistantService } from "../../core/index.js";

function errorResponse(res, err) {
  const status = err?.status || 500;
  const code = err?.code || (status === 500 ? "assistant_failed" : "validation");
  return res.status(status).json({ error: { code, message: err?.message || String(err) } });
}

export function registerAssistantRoutes(app, { db, broker, logger, config, runAgent } = {}) {
  const assistant = createWorklabAssistantService({ db, broker, logger, config, runAgent });

  function runEventLimit(value) {
    const parsed = Number(value || 200);
    if (!Number.isInteger(parsed) || parsed < 1) return 200;
    return Math.min(parsed, 500);
  }

  app.get("/api/assistant", (_req, res) => {
    try {
      res.json(assistant.getDefaultThread());
    } catch (err) {
      errorResponse(res, err);
    }
  });

  app.post("/api/assistant/messages", (req, res) => {
    try {
      const result = assistant.startMessage({ body: req.body?.body });
      res.status(202).json(result);
    } catch (err) {
      errorResponse(res, err);
    }
  });

  app.get("/api/assistant/runs/:id", (req, res) => {
    try {
      const includeEvents = req.query.events !== "none";
      const eventLimit = req.query.events === "tail" ? runEventLimit(req.query.limit) : null;
      const run = assistant.getRun(req.params.id, { includeEvents, eventLimit });
      if (!run) return res.status(404).json({ error: { code: "not_found", message: "assistant run not found" } });
      res.json({ run });
    } catch (err) {
      errorResponse(res, err);
    }
  });

  app.post("/api/assistant/runs/:id/cancel", (req, res) => {
    try {
      const result = assistant.cancelRun(req.params.id, {
        initiator: "api_cancel",
        reason: req.body?.reason || "user requested cancellation",
      });
      if (!result.ok) return res.status(result.status).json({ error: { code: result.code, message: result.message } });
      res.status(202).json({ run: result.run });
    } catch (err) {
      errorResponse(res, err);
    }
  });

  app.get("/api/assistant/runs/:id/stream", (req, res) => {
    broker.subscribe(`assistant:${req.params.id}`, res);
  });

  return assistant;
}
