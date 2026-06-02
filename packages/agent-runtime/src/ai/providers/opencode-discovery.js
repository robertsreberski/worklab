import { createOpencode } from "@opencode-ai/sdk";

// Enumerate the providers/models OpenCode is configured for (auth.json + opencode.json
// + models.dev). Boots a transient `opencode` server, so callers should cache the
// result rather than call this per request. Returns a normalized provider/model list.
//
// config.providers() → { data: { providers: Provider[], default } }, where each
// Provider has { id, name, source, models: { [id]: Model } } and each Model exposes
// capabilities { reasoning, toolcall, input.image }, limit.context, and status.
export async function discoverOpencodeProviders({ createServer = createOpencode } = {}) {
  const opencode = await createServer({ config: {} });
  const { client, server } = opencode;
  try {
    const result = await client.config.providers();
    if (result?.error) {
      const message = typeof result.error === "string"
        ? result.error
        : (result.error?.message || JSON.stringify(result.error));
      throw new Error(message);
    }
    const providers = result?.data?.providers || result?.providers || [];
    return providers.map((provider) => ({
      providerID: provider.id,
      name: provider.name || provider.id,
      source: provider.source || null,
      models: Object.values(provider.models || {}).map((model) => ({
        id: model.id,
        name: model.name || model.id,
        reasoning: !!model.capabilities?.reasoning,
        toolCall: !!model.capabilities?.toolcall,
        vision: !!model.capabilities?.input?.image,
        contextWindow: Number(model.limit?.context) || null,
        status: model.status || null,
      })),
    }));
  } finally {
    try { server?.close?.(); } catch { /* best effort */ }
  }
}
