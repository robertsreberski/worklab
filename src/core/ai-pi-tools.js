// Re-export shim. Real implementation lives in src/agent/tools/pi-bridge.js
// as part of the Phase 4 agent-kernel extraction. The bridge wraps Worklab's
// built-in tools as PI Agent SDK tools and stitches in MCP clients.
export * from "../agent/tools/pi-bridge.js";
