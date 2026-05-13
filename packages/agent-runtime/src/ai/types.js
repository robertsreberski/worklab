// Worklab AI runtime contracts. These are JSDoc-only; the codebase is JS
// (no TypeScript), so the types document the bridge surface that active
// runtimes implement through src/ai/runtime/registry.js.

/**
 * @typedef {Object} RuntimeModelRef
 * @property {"claude" | "pi" | "codex"} sdk Canonical active runtime id.
 * @property {string} model              Provider model id.
 * @property {string} reference          Original canonical model reference.
 * @property {string} [provider]         Pi provider id when sdk === "pi".
 */

/**
 * @typedef {Object} RuntimeRequest
 * @property {string} systemPrompt
 * @property {Array<Object>} messages
 * @property {RuntimeModelRef} model
 * @property {string} [effort]
 * @property {boolean} [fastMode]
 * @property {string} [cwd]
 * @property {Object<string, Object>} [mcpServers]
 * @property {Array<string>} [allowedTools]
 * @property {Array<string>} [disallowedTools]
 * @property {string} [permissionMode]
 * @property {number} [maxTurns]
 * @property {Object} [outputSchema]
 * @property {string} [runArtifactDir]
 * @property {AbortSignal} [abortSignal]
 * @property {Object} [liveInput]
 * @property {Object} [settings]
 * @property {Object} [nativeSubagents] Same-runtime teammate helpers exposed through native provider subagent surfaces.
 * @property {(event: RuntimeEvent) => void} [onEvent]
 */

/**
 * @typedef {Object} RuntimeEvent
 * @property {string} type
 */

/**
 * @typedef {Object} RuntimeResult
 * @property {string|null} [text]
 * @property {*} [structuredResult]
 * @property {string|null} [structuredResultSource]
 * @property {Array<RuntimeEvent>} [events]
 * @property {Object} [usage]
 * @property {number} [durationMs]
 * @property {number} [numTurns]
 * @property {string} [model]
 * @property {string} [effort]
 * @property {"claude" | "pi" | "codex"} [sdk]
 * @property {boolean} [cancelled]
 * @property {string|null} [error]
 * @property {Object|null} [errorDetails]
 * @property {string|null} [failureKind]
 * @property {string|null} [providerSessionId]
 * @property {Array<Object>} [runtimeWarnings]
 * @property {Object} [diagnostics]
 */

/**
 * @typedef {Object} RuntimeBridge
 * @property {"claude" | "pi" | "codex"} id
 * @property {(ref: RuntimeModelRef) => boolean} supports
 * @property {(ref?: RuntimeModelRef) => Object} capabilities
 * @property {(systemPrompt: string, req: RuntimeRequest) => Promise<RuntimeResult>} execute
 */

export const PROVIDER_KIND_VALUES = ["claude", "pi", "codex"];
