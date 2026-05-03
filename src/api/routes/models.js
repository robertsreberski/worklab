import {
  buildModelCapabilities,
  getBuiltinModelGroups,
  getBuiltinProviderAvailability,
  isValidProviderType,
  listModels,
  listProviders,
} from "../../core/index.js";

const OPENAI_EMBEDDING_MODELS = [
  { model: "text-embedding-3-small", label: "text-embedding-3-small", description: "1536 dims, low cost" },
  { model: "text-embedding-3-large", label: "text-embedding-3-large", description: "3072 dims, higher quality" },
  { model: "text-embedding-ada-002", label: "text-embedding-ada-002", description: "Legacy, 1536 dims" },
];

function runtimeModelMetadata(model, group, availability) {
  const groupAvailable = availability?.available !== false;
  const unavailableReason = groupAvailable ? null : (availability?.reason || "Provider unavailable");
  const capabilities = model.capabilities || {};
  return {
    ...model,
    runtime_kind: capabilities.runtime_kind || availability?.runtime_kind || group.runtime_kind || "sdk",
    available: groupAvailable,
    disabled: !groupAvailable,
    unavailable_reason: unavailableReason,
    supports_skills: capabilities.supports_skills !== false,
    supports_mcp: capabilities.supports_mcp !== false,
    supports_worklab_tools: capabilities.supports_worklab_tools !== false && model.supports_builtin_tools !== false,
    native_tools_note: capabilities.native_tools_note || model.native_tools_note || null,
    mcp_mode: capabilities.mcp_mode || null,
    skills_mode: capabilities.skills_mode || "prompt-index",
  };
}

export function registerModelRoutes(app, { db, dataDir }) {
  app.get("/api/models/available", (_req, res) => {
    const groups = getBuiltinModelGroups();
    const availability = getBuiltinProviderAvailability({ dataDir });
    for (const group of groups) {
      const avail = availability[group.id];
      if (avail) {
        group.available = avail.available;
        group.unavailable_reason = avail.reason;
        group.disabled = !avail.available;
        group.runtime_kind = avail.runtime_kind;
        group.version = avail.version || null;
        group.auth = avail.auth || null;
      }
      group.models = (group.models || []).map((model) => runtimeModelMetadata(model, group, avail));
    }

    for (const provider of listProviders({ db, dataDir, enabledOnly: true })) {
      if (!isValidProviderType(provider.provider_type)) continue;
      const models = listModels({ db, providerId: provider.id, enabledOnly: true }).flatMap((model) => {
        const capabilities = buildModelCapabilities(provider.provider_type, model.model_name, model.capabilities);
        if (!capabilities.runnable_for_agent) return [];
        return [{
          value: `pi:${provider.id}:${model.model_name}`,
          label: model.display_name || model.model_name,
          description: `${provider.name} / ${model.model_name}`,
          sdk: "pi",
          runtime_kind: "pi-agent",
          provider_id: provider.id,
          provider_name: provider.name,
          provider_type: provider.provider_type,
          model_name: model.model_name,
          capabilities,
          available: true,
          disabled: false,
          unavailable_reason: null,
          builtin_tools: capabilities.builtin_tools,
          supports_builtin_tools: capabilities.supports_builtin_tools,
          supports_skills: true,
          supports_mcp: true,
          supports_worklab_tools: capabilities.supports_builtin_tools,
          native_tools_note: null,
          mcp_mode: "sdk",
          skills_mode: "read-skill-tool",
          pricing: model.pricing,
        }];
      });
      if (models.length) {
        groups.push({
          id: provider.id,
          label: provider.name,
          provider_type: provider.provider_type,
          available: true,
          disabled: false,
          unavailable_reason: null,
          runtime_kind: "pi-agent",
          models,
        });
      }
    }

    res.json({ groups, models: groups.flatMap((group) => group.models) });
  });

  app.get("/api/models/embeddings", (_req, res) => {
    const availability = getBuiltinProviderAvailability({ dataDir });
    const groups = [{
      id: "openai",
      label: "OpenAI",
      available: availability.openai.available,
      unavailable_reason: availability.openai.reason,
      disabled: !availability.openai.available,
      models: OPENAI_EMBEDDING_MODELS.map((m) => ({
        value: `openai:${m.model}`,
        label: m.label,
        description: availability.openai.available ? m.description : (availability.openai.reason || m.description),
        available: availability.openai.available,
        disabled: !availability.openai.available,
        unavailable_reason: availability.openai.reason,
      })),
    }];

    for (const provider of listProviders({ db, dataDir, enabledOnly: true })) {
      if (!isValidProviderType(provider.provider_type)) continue;
      const embeddingModels = listModels({ db, providerId: provider.id }).filter((m) => {
        const caps = m.capabilities || {};
        return caps.embedding === true || /embed/i.test(m.model_name);
      });
      if (!embeddingModels.length) continue;
      groups.push({
        id: provider.id,
        label: provider.name,
        provider_type: provider.provider_type,
        available: true,
        disabled: false,
        unavailable_reason: null,
        models: embeddingModels.map((m) => ({
          value: `vercel:${provider.id}:${m.model_name}`,
          label: m.display_name || m.model_name,
          description: m.enabled ? `${provider.name} / ${m.model_name}` : "Enable this model in Providers to select it.",
          available: !!m.enabled,
          disabled: !m.enabled,
          unavailable_reason: m.enabled ? null : "Model is disabled in Providers.",
        })),
      });
    }

    res.json({ groups });
  });
}
