// Public entry for @worklab-ai/agent-runtime.
//
// Most consumers should reach for `createRuntime` (see runtime.js) — it
// binds the host integration callbacks once and returns a `.run()` method.
// The named exports below remain available for advanced use cases (custom
// bridge registration, direct provider invocation, tool-runtime introspection).

export { createRuntime } from "./runtime.js";
export {
  configureToolRuntime,
  readToolRuntime,
  readRuntimeBrand,
  resetToolRuntime,
} from "./agent/tools/shared/runtime-context.js";
export {
  DEFAULT_RUNTIME_BRAND,
  resolveRuntimeBrand,
} from "./runtime-brand.js";

export * from "./ai/index.js";
export * from "./agent/index.js";
