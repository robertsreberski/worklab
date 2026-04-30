// Public re-export shim so existing callers (src/worker.js,
// src/mcp/agent/server.js, src/api/routes/tasks.js, and tests under
// src/__tests__/mcp/) keep working without import-path changes. The
// implementation now lives under src/mcp/agent/tools/, split per domain.

export { toolDefinitions, createToolHandlers, renderToolSurfaceMarkdown } from "./tools/index.js";
