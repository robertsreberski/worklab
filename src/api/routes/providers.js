import {
  buildModelCapabilities,
  createProvider,
  deleteProvider,
  discoverModels,
  getModel,
  getProvider,
  isValidProviderType,
  listModels,
  listProviders,
  setModelEnabled,
  testProvider,
  updateProvider,
  upsertModel,
} from "../../core/index.js";
import { countModelsForProvider } from "../../core/db/queries/providers.js";
import { listAgentModelRefs } from "../../core/db/queries/agents.js";

function error(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

function withCapabilities(provider, model) {
  return {
    ...model,
    capabilities: buildModelCapabilities(provider.provider_type, model.model_name, model.capabilities),
  };
}

function modelRunStatus(provider, model, capabilities = model.capabilities) {
  return buildModelCapabilities(provider.provider_type, model.model_name, capabilities);
}

export function registerProviderRoutes(app, { db, dataDir, broker }) {
  app.get("/api/providers", (_req, res) => {
    const providers = listProviders({ db, dataDir }).map((provider) => ({
      ...provider,
      model_count: countModelsForProvider(db, provider.id),
    }));
    res.json({ providers });
  });

  app.get("/api/providers/:id", (req, res) => {
    const provider = getProvider({ db, dataDir, id: req.params.id, includeKey: false });
    if (!provider) return error(res, 404, "not_found", "provider not found");
    res.json({ provider });
  });

  app.post("/api/providers", (req, res) => {
    const body = req.body || {};
    if (!body.name) return error(res, 400, "validation", "name required");
    if (!isValidProviderType(body.provider_type)) return error(res, 400, "validation", "invalid provider_type");
    try {
      const provider = createProvider({
        db,
        dataDir,
        name: body.name,
        provider_type: body.provider_type,
        base_url: body.base_url,
        api_key: body.api_key || null,
        trust_public_url: !!body.trust_public_url,
        enabled: body.enabled !== false,
      });
      broker.broadcast("global", { type: "provider_updated", id: provider.id });
      res.status(201).json({ provider });
    } catch (err) {
      error(res, 400, "validation", err.message);
    }
  });

  app.patch("/api/providers/:id", (req, res) => {
    if (!getProvider({ db, dataDir, id: req.params.id, includeKey: false })) {
      return error(res, 404, "not_found", "provider not found");
    }
    try {
      const provider = updateProvider({ db, dataDir, id: req.params.id, patch: req.body || {} });
      broker.broadcast("global", { type: "provider_updated", id: provider.id });
      res.json({ provider });
    } catch (err) {
      error(res, 400, "validation", err.message);
    }
  });

  app.delete("/api/providers/:id", (req, res) => {
    if (!deleteProvider({ db, id: req.params.id })) return error(res, 404, "not_found", "provider not found");
    broker.broadcast("global", { type: "provider_deleted", id: req.params.id });
    res.status(204).end();
  });

  app.post("/api/providers/:id/test", async (req, res) => {
    if (!getProvider({ db, dataDir, id: req.params.id, includeKey: false })) {
      return error(res, 404, "not_found", "provider not found");
    }
    res.json(await testProvider({ db, dataDir, providerId: req.params.id }));
  });

  app.post("/api/providers/:id/discover", async (req, res) => {
    if (!getProvider({ db, dataDir, id: req.params.id, includeKey: false })) {
      return error(res, 404, "not_found", "provider not found");
    }
    try {
      const provider = getProvider({ db, dataDir, id: req.params.id, includeKey: false });
      const models = await discoverModels({ db, dataDir, providerId: req.params.id });
      broker.broadcast("global", { type: "provider_models_updated", id: req.params.id });
      res.json({ models: models.map((model) => withCapabilities(provider, model)) });
    } catch (err) {
      error(res, 502, "discovery_failed", err.message);
    }
  });

  app.get("/api/providers/:id/models", (req, res) => {
    if (!getProvider({ db, dataDir, id: req.params.id, includeKey: false })) {
      return error(res, 404, "not_found", "provider not found");
    }
    const provider = getProvider({ db, dataDir, id: req.params.id, includeKey: false });
    res.json({ models: listModels({ db, providerId: req.params.id }).map((model) => withCapabilities(provider, model)) });
  });

  app.patch("/api/providers/:id/models/:modelId", (req, res) => {
    const model = getModel({ db, id: req.params.modelId });
    if (!model || model.provider_id !== req.params.id) return error(res, 404, "not_found", "model not found");
    const body = req.body || {};
    const provider = getProvider({ db, dataDir, id: req.params.id, includeKey: false });
    try {
      if (body.enabled === true) {
        const capabilities = modelRunStatus(provider, model, body.capabilities ?? model.capabilities);
        if (!capabilities.runnable_for_agent && capabilities.embedding !== true) {
          return error(res, 400, "validation", `model is not runnable for agents or embeddings: ${capabilities.unavailable_reason}`);
        }
      }
      let updated;
      if (body.display_name !== undefined || body.alias !== undefined || body.capabilities !== undefined || body.pricing !== undefined) {
        updated = upsertModel({
          db,
          providerId: req.params.id,
          modelName: model.model_name,
          displayName: body.display_name ?? model.display_name,
          alias: body.alias ?? model.alias,
          capabilities: body.capabilities ?? model.capabilities,
          pricing: body.pricing ?? model.pricing,
          ...(body.enabled !== undefined ? { enabled: !!body.enabled } : {}),
        });
      } else if (body.enabled !== undefined) {
        updated = setModelEnabled({ db, id: req.params.modelId, enabled: !!body.enabled });
      } else {
        updated = model;
      }
      broker.broadcast("global", { type: "provider_models_updated", id: req.params.id });
      res.json({ model: withCapabilities(provider, updated) });
    } catch (err) {
      error(res, 400, "validation", err.message);
    }
  });

  // Reverse link: which agents point at this provider. Agent model strings
  // for custom providers are of the form `pi:<providerId>:<modelName>`
  // (see core/ai.js parseModelReference), so an exact prefix match is a
  // reliable signal that this provider is in use.
  app.get("/api/providers/:id/agents", (req, res) => {
    if (!getProvider({ db, dataDir, id: req.params.id, includeKey: false })) {
      return error(res, 404, "not_found", "provider not found");
    }
    const prefix = `pi:${req.params.id}:`;
    const agents = listAgentModelRefs(db).filter((row) => (row.model || "").startsWith(prefix));
    res.json({ agents });
  });
}
