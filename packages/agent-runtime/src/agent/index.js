// Public surface of the agent kernel. The kernel is consumed by the
// worker, the assistant, the Slack triage path, and the coordinator's
// run-spawn path. Everything below is intentionally re-exported; anything
// not listed here is private to the kernel and should not be imported
// from edge layers.

export {
  createAgentCompactionManager,
  isLikelyContextTermination,
} from "./compaction.js";

export {
  buildTranscriptTailSnapshot,
  renderResumeSnapshot,
} from "./transcript.js";

export {
  ALLOWLIST_MODE_ALL,
  ALLOWLIST_MODE_CUSTOM,
  inferAllowlistMode,
  normalizeAllowlistMode,
  normalizeList,
  parseStoredAllowlist,
  resolveAllowlist,
  resolveAllowlistMap,
  storedAllowlistMode,
} from "./allowlists.js";

export {
  APPROVAL_DECISIONS,
  RISK_TIERS,
  createApprovalManager,
  wrapToolsWithApprovalGate,
} from "./approval.js";

export {
  BINARY_BLOAT_TOOLS,
  DEFAULT_TOOL_BLOAT_CONFIG,
  MAX_TOOL_RESULT_BYTES,
} from "./tool-bloat.js";
