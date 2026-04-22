import { BUILTIN_CLAUDE_MODELS, BUILTIN_OPENAI_MODELS } from "../core/ai.js";
import { listModels, listProviders } from "../core/providers.js";

function modelLabel(model) {
  return model;
}

export function registerModelRoutes(app, { db, dataDir }) {
  app.get("/api/models/available", (_req, res) => {
    const groups = [
      {
        id: "claude",
        label: "Claude",
        models: BUILTIN_CLAUDE_MODELS.map((model) => ({
          value: `claude:${model}`,
          label: modelLabel(model),
          sdk: "claude",
          model,
        })),
      },
      {
        id: "openai",
        label: "OpenAI",
        models: BUILTIN_OPENAI_MODELS.map((model) => ({
          value: `openai:${model}`,
          label: modelLabel(model),
          sdk: "openai",
          model,
        })),
      },
    ];

    for (const provider of listProviders({ db, dataDir, enabledOnly: true })) {
      const models = listModels({ db, providerId: provider.id, enabledOnly: true }).map((model) => ({
        value: `vercel:${provider.id}:${model.model_name}`,
        label: model.display_name || model.model_name,
        description: `${provider.name} / ${model.model_name}`,
        sdk: "vercel",
        provider_id: provider.id,
        provider_name: provider.name,
        provider_type: provider.provider_type,
        model_name: model.model_name,
        capabilities: model.capabilities,
        pricing: model.pricing,
      }));
      if (models.length) {
        groups.push({ id: provider.id, label: provider.name, provider_type: provider.provider_type, models });
      }
    }

    res.json({ groups, models: groups.flatMap((group) => group.models) });
  });
}
