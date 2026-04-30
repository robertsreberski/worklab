// Public re-export shim so existing callers (src/cli/mcp.js,
// src/mcp/admin/server.js, and tests under src/__tests__/mcp/) keep working
// without import-path changes. The implementation now lives under
// src/mcp/admin/tools/, split per domain.

export { adminToolDefinitions, createAdminToolHandlers, apiRequest } from "./tools/index.js";
