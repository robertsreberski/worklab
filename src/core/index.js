// Public surface of the Worklab domain layer. Re-exports the most-used
// helpers across the codebase so edge layers (api, mcp, integrations,
// cli) and the coordinator/worker can prefer `from "core"` over deep
// per-file paths. Modules not re-exported here are private to the domain.

export {
  closeDb,
  getDb,
  openDb,
} from "./db/open.js";

export { runMigrations } from "./db/migrations/runner.js";
export { SCHEMA_SQL, SCHEMA_VERSION } from "./db/schema/current.js";

export {
  DECISIONS,
  DEFAULT_MAX_FAILURES,
  DEFAULT_MAX_REJECTIONS,
  FAILURE_KINDS,
  PROCESS_STATUSES,
  STAGES,
  nextStage,
} from "./state-machine.js";

export {
  applyTaskSideEffects,
  taskStage,
} from "./task-side-effects.js";

export { resumeWaitingParents } from "./task-joins.js";
export { delegationDepth } from "./delegation.js";

export {
  agentForTaskStage,
  missingAgentMessageForTaskStage,
} from "./task-agents.js";

export {
  WORKLAB_BUILTIN_TOOLS,
  generateResponse,
  parseModelReference,
  resolveModel,
} from "./ai.js";

export {
  newAgentLogId,
  newAutomationId,
  newAutomationRunId,
  newAutomationTriggerId,
  newCommentId,
  newRunId,
  newSlackDeliveryId,
  newSlackInboundEventId,
  newTaskId,
} from "./ids.js";

export { isValidSlug, slugify, uniqueSlug } from "./slugs.js";
