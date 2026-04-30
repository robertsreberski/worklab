// Provider-layer type contracts. These are JSDoc-only; the codebase is JS
// (no TypeScript) so the types act as documentation and as targets for the
// provider registry's `validate` step. When a provider is added, it implements
// this contract and registers itself via `registerProvider`.

/**
 * @typedef {Object} ProviderModelRef
 * @property {string} sdk         Provider id ("claude" | "pi" | "claude-cli" | "codex-cli" | "codex-app" | …)
 * @property {string} model       Model name (e.g. "claude-opus-4-7")
 * @property {string} reference   Canonical "sdk:model" string used by callers
 * @property {string} [provider]  Custom-provider id when sdk === "pi" / "openai-compat"
 */

/**
 * @typedef {Object} RunRequest
 * @property {string}             systemPrompt
 * @property {Array<Object>}      messages         Multi-turn message array (provider-normalized)
 * @property {ProviderModelRef}   model
 * @property {Array<Object>}      [tools]          Tool definitions visible to the model
 * @property {string}             [effort]         Reasoning effort: low/medium/high/xhigh/max
 * @property {AbortSignal}        [signal]
 * @property {(event: ProviderEvent) => void} [onEvent]
 */

/**
 * @typedef {Object} ProviderEvent
 * @property {string} type   "text" | "tool_use" | "tool_result" | "thinking" | "final" | …
 *
 * The exact payload depends on `type`. See `src/ai/streaming/events.js` for
 * normalized event shapes.
 */

/**
 * @typedef {Object} ProviderResult
 * @property {string}            status        "complete" | "error" | "cancelled"
 * @property {string}             [text]
 * @property {Object}             [worklab_result]
 * @property {Object}             [usage]
 * @property {string}             [model]
 * @property {string}             [providerSessionId]
 * @property {Array<Object>}      [warnings]
 * @property {string}             [failureKind]
 * @property {string}             [error]
 */

/**
 * @typedef {Object} ApiProvider
 * @property {string}    id                  Stable identifier ("claude", "pi", …)
 * @property {(ref: ProviderModelRef) => boolean} supports
 * @property {(req: RunRequest) => Promise<ProviderResult>} execute
 * @property {() => { available: boolean, reason?: string }} [validate]
 */

export const PROVIDER_KIND_VALUES = ["claude", "pi", "claude-cli", "codex-cli", "codex-app"];
