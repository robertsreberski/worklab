// Public surface of the Worklab domain layer. Re-exports the helpers used
// across the codebase so edge layers (api, mcp, integrations, cli) and the
// coordinator/worker can prefer `from "../core/index.js"` over deep
// per-file paths. Modules not re-exported here are private to the domain.
//
// SQL helpers in src/core/db/queries/* are intentionally NOT re-exported.
// API routes are allowed to reach into them directly (the agreed pattern
// after PR-2..PR-6 migrated raw db.prepare calls into named query helpers).
// Other edge layers should call higher-level domain modules instead.

// ---------- Database lifecycle + schema ----------
export {
  closeDb,
  getDb,
  openDb,
} from "./db/open.js";

export { runMigrations } from "./db/migrations/runner.js";
export { SCHEMA_SQL, SCHEMA_VERSION } from "./db/schema/current.js";

// ---------- Task workflow + state machine ----------
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
  backfillTaskKeys,
  formatTaskKey,
  maxTaskKeyNumber,
  nextTaskKey,
  normalizeTaskKey,
  resolveTaskId,
  resolveTaskRow,
  taskKeyNumber,
} from "./task-keys.js";

// ---------- AI + provider dispatch ----------
export {
  BUILTIN_CLAUDE_MODELS,
  BUILTIN_CODEX_MODELS,
  BUILTIN_OPENAI_MODELS,
  VALID_MODEL_SDKS,
  WORKLAB_BUILTIN_TOOLS,
  generateResponse,
  getBuiltinModelByReference,
  getBuiltinModelGroups,
  getBuiltinModels,
  isValidModelReference,
  normalizeReasoningEffortForModel,
  parseModelReference,
  resolveBackendFor,
  resolveModel,
} from "./ai.js";

export {
  buildModelCapabilities,
  createProvider,
  createVercelClient,
  defaultOllamaNumCtx,
  deleteProvider,
  discoverModels,
  getModel,
  getModelByProviderAndName,
  getProvider,
  inferOllamaReasoningProfile,
  isOpenAICompatibleProviderType,
  isPrivateBaseUrl,
  isValidProviderType,
  listModels,
  listProviders,
  OPENAI_COMPAT_PROVIDER_TYPES,
  PROVIDER_TYPES,
  resolveAgentRunnableStatus,
  resolveReasoningCapabilities,
  resolveVercelModel,
  setModelEnabled,
  testProvider,
  updateProvider,
  upsertModel,
  validateBaseUrl,
} from "./providers.js";

export { getBuiltinProviderAvailability } from "./credentials.js";

// ---------- IDs + slugs ----------
export {
  newAgentLogId,
  newAutomationId,
  newAutomationRunId,
  newAutomationTriggerId,
  newCommentId,
  newProjectId,
  newRunId,
  newSlackDeliveryId,
  newSlackInboundEventId,
  newTaskId,
} from "./ids.js";

export { isValidSlug, slugify, uniqueSlug } from "./slugs.js";

// ---------- Settings + runtime ----------
export {
  DEFAULT_SETTINGS,
  readSettings,
  validateSetting,
  validateSettingsPatch,
  writeSettings,
} from "./settings.js";

export {
  RUNTIME_SETTING_FIELDS,
  readRuntimeEnvFile,
  readRuntimeSettings,
  runtimeEnvFromValues,
  validateRuntimeSetting,
  validateRuntimeSettingsPatch,
  writeRuntimeSettings,
} from "./runtime-settings.js";

// ---------- Configuration + bootstrap ----------
export { config, loadConfig, localClientHost, worklabBaseUrl } from "./config.js";
export {
  bootstrapWorklabEnv,
  defaultDataDir,
  loadEnvFile,
  resolveDataDirFromEnv,
} from "./env.js";
export { seedDataFromTemplate } from "./first-boot.js";
export { logger, createLogger } from "./logger.js";

// ---------- Crypto + tokens + service ----------
export {
  decrypt,
  encrypt,
  getKeyFingerprint,
  getKeySource,
} from "./crypto.js";

export {
  ensureMcpToken,
  mcpTokenPath,
  readMcpToken,
  tokenMatches,
} from "./service-token.js";

export { serviceStatus } from "./host-service-status.js";

// ---------- Runs (input, events, logs, artifacts) ----------
export {
  assertAgentRunnable,
  buildNextTaskRunPreview,
  buildTaskRunInput,
  buildTaskRunMessages,
  hasOpenBlocker,
  latestPriorExecuteRunId,
  loadAgentCapabilities,
  loadPriorRunSummaries,
  loadTaskRunSetup,
  modeForTaskStage,
  selectCurrentRunComments,
} from "./run-input.js";

export {
  buildRunLifecycleEvent,
  tailRunEventsByVisibleItems,
} from "./run-events.js";

export {
  EMPTY_RUN_TODO_STATE,
  EMPTY_RUN_TODO_STATE_JSON,
  RUN_TODO_MAX_ACTIVE_FORM_LENGTH,
  RUN_TODO_MAX_CONTENT_LENGTH,
  RUN_TODO_MAX_ITEMS,
  RUN_TODO_STATUSES,
  createRunTodoState,
  inheritRunTodoState,
  normalizeRunTodoItems,
  normalizeRunTodoState,
  runTodoStateSummary,
  serializeRunTodoState,
} from "./run-todos.js";

export {
  aggregateRunArtifacts,
  artifactDeltaLabel,
  artifactPaths,
  artifactsForRunRow,
  artifactsFromPaths,
  buildRunArtifactTree,
  extractRunArtifacts,
  formatTaskArtifactsForPrompt,
  loadTaskArtifacts,
  normalizeArtifactPath,
  normalizeStoredArtifacts,
  runArtifactSummary,
} from "./run-artifacts.js";

export { resolveRunArtifactDir } from "./run-artifact-paths.js";

export { readRunLog } from "./run-logs.js";

export {
  captureGitArtifactState,
  collectGitArtifacts,
  collectQaOutputArtifacts,
  collectWorkspaceDeltaArtifacts,
  createWorkspaceSnapshot,
  safeRunArtifactPath,
} from "./artifact-collection.js";

export {
  RUNTIME_TASK_GROUPS,
  RUNTIME_TASK_GROUP_KEYS,
  buildRuntimeTaskSummary,
  compareRuntimeTasks,
  runtimeTaskAttentionItems,
  runtimeTaskGroupKey,
  runtimeTaskUnresolvedDependencyCount,
  runtimeTaskVisibility,
  taskHasEnabledAutomation,
  taskHasRunError,
  taskHasRunningRun,
  taskRecoveryLabel,
  taskRecoveryState,
} from "./task-runtime.js";

// ---------- Notifications (push + web-push) ----------
export {
  buildRunNotification,
  buildRunPushPayload,
  runNotificationKind,
  runNotificationRoute,
} from "./run-notifications.js";

export {
  deletePushSubscription,
  disablePushSubscription,
  listActivePushSubscriptions,
  normalizePushSubscription,
  pruneDisabledPushSubscriptions,
  pushSubscriptionFromRow,
  upsertPushSubscription,
} from "./push-notifications.js";

export {
  getVapidKeys,
  sendWebPushNotification,
  vapidKeyPath,
  vapidPublicKey,
} from "./web-push.js";

// ---------- Live input + comments ----------
export {
  LIVE_INPUT_MAX_BODY_LENGTH,
  createLiveInputQueue,
  formatLiveInputGuidance,
  normalizeLiveInputBody,
  supportsLiveInputProvider,
} from "./live-input.js";

export { enrichCommentRows } from "./comments.js";

// ---------- Knowledge base ----------
export {
  kbCreate,
  kbDelete,
  kbList,
  kbListPinned,
  kbPath,
  kbRead,
  kbUpdate,
} from "./kb.js";

// ---------- Journals + memory ----------
export {
  agentJournalPath,
  agentMemoryPath,
  appendJournalEntry,
  appendJournalSummary,
  appendMemoryFacts,
  readFullJournal,
  readJournalTail,
  readRunSection,
  writeMemory,
} from "./journal.js";

export {
  agentJournalHash,
  readAgentMemoryContent,
  readAgentMemoryContext,
  readAgentMemoryState,
} from "./memory.js";

// ---------- Projects ----------
export {
  agentNameAllowedByPatterns,
  agentNameMatchesPattern,
  compactProject,
  loadProjectAgentAllowlist,
  loadRunSnapshot,
  normalizeProjectSlug,
  normalizeProjectWorkdir,
  parseProjectAllowedAgents,
  parseProjectTags,
  projectContextHash,
  projectFromRow,
  projectRouteError,
  resolveProjectId,
  resolveProjectRow,
  resolveTaskProjectRunContext,
  uniqueProjectSlug,
} from "./projects.js";

// ---------- Automations ----------
export {
  createAutomationRunRows,
  createAutomationTriggerRow,
  nextAutomationStateAfterFire,
  nextFireAt,
  normalizeTrigger,
  parseRunAt,
  rowToAutomation,
  triggerSummary,
  upcomingFireTimes,
} from "./automations.js";

// ---------- Skills + MCP config ----------
export {
  SkillImportError,
  buildSkillFileTree,
  buildSkillIndex,
  importSkillZip,
  loadSkills,
  parseSkillFrontmatter,
  stripFrontmatter,
} from "./skills.js";

export {
  checkMcpServerHealth,
  getAvailableMcpServers,
  getBuiltinMcpServers,
  getMcpServerHealth,
  getMcpServerStatuses,
  loadMcpConfig,
  pickMcpServers,
  validateMcpServerConfig,
} from "./mcp-config.js";

// ---------- Embeddings ----------
export {
  DEFAULT_EMBEDDING_MODEL,
  bufferToFloatArray,
  chunkMarkdown,
  cosineSimilarity,
  floatArrayToBuffer,
  generateEmbedding,
  getEmbeddingModel,
  getIndexStatus,
  hashText,
  indexAllSources,
  indexPath,
  indexSource,
  isEmbeddingBackendReady,
  parseEmbeddingReference,
  removeSource,
  scanSources,
  search,
  testEmbeddingBackend,
} from "./embeddings.js";

// ---------- Execenv ----------
export {
  execenvBaseDir,
  execenvRoot,
  prepareExecenv,
  teardownExecenv,
  writeRuntimeConfig,
} from "./execenv.js";

// ---------- Assistant ----------
export {
  DEFAULT_ASSISTANT_THREAD_ID,
  WorklabAssistantService,
  createWorklabAssistantService,
} from "./assistant.js";
export {
  ASSISTANT_RESULT_JSON_SCHEMA,
  parseAssistantResult,
} from "./assistant/result.js";
