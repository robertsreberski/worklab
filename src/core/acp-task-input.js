import { isAbsolute, basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { attachmentStoredFilePath } from "./task-attachments.js";
import { WORKLAB_RESULT_JSON_SCHEMA } from "./worklab-result/contract.js";

const MAX_HISTORY_TEXT_CHARS = 4_000;
const MAX_REVIEW_TEXT_CHARS = 8_000;

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function clip(value, maxChars = MAX_HISTORY_TEXT_CHARS) {
  const valueText = text(value);
  if (valueText.length <= maxChars) return valueText;
  return `${valueText.slice(0, maxChars)}\n...[truncated]`;
}

function section(title, body) {
  const bodyText = text(body);
  return bodyText ? `## ${title}\n\n${bodyText}` : "";
}

function timestamp(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function runtimeContext(context = {}) {
  return [
    context.runStartedAt ? `Run started: ${context.runStartedAt}` : "",
    context.timezone ? `Timezone: ${context.timezone}` : "",
    context.localTime ? `Local time: ${context.localTime}` : "",
    context.today ? `Today: ${context.today}` : "",
    context.yesterday ? `Yesterday: ${context.yesterday}` : "",
  ].filter(Boolean).join("\n");
}

function commentAuthor(comment = {}) {
  const authorType = comment.author_type || comment.author?.type || "system";
  const authorId = comment.author_id || comment.author?.id || "";
  const displayName = comment.author?.display_name || comment.author?.displayName || "";
  if (displayName) return `${authorType} ${displayName}`;
  return authorId ? `${authorType} ${authorId}` : authorType;
}

function formatComments(comments = []) {
  return comments.map((comment, index) => [
    `### Comment ${index + 1} (${commentAuthor(comment)})`,
    clip(comment.body || comment.content || ""),
  ].filter(Boolean).join("\n\n")).join("\n\n");
}

function formatSavedPlan(task = {}) {
  const body = text(task.plan_body);
  if (!body) return "";
  return [
    "Treat this saved plan as task-owned implementation context.",
    task.plan_source_run_id ? `Source run: \`${task.plan_source_run_id}\`` : "",
    task.plan_updated_by ? `Updated by: ${task.plan_updated_by}` : "",
    timestamp(task.plan_updated_at) ? `Updated: ${timestamp(task.plan_updated_at)}` : "",
    body,
  ].filter(Boolean).join("\n\n");
}

function formatPriorRuns(priorRuns = []) {
  return priorRuns.map((run, index) => {
    const lines = [
      `### Prior run ${index + 1}`,
      run.id ? `Run id: \`${run.id}\`` : "",
      `Mode: ${run.mode || "unknown"}`,
      `Status: ${run.status || "unknown"}`,
      timestamp(run.startedAt) ? `Started: ${timestamp(run.startedAt)}` : "",
      timestamp(run.endedAt) ? `Ended: ${timestamp(run.endedAt)}` : "",
    ];
    const outcome = clip(run.finalText || run.errorText || "");
    if (outcome) lines.push("", "Outcome:", outcome);
    return lines.filter((line) => line !== "").join("\n");
  }).join("\n\n");
}

function artifactLine(artifact = {}) {
  const path = artifact.display_path || artifact.path;
  if (!path) return "";
  const kind = artifact.kind || artifact.status || "artifact";
  const added = Number(artifact.added_lines || 0);
  const removed = Number(artifact.removed_lines || 0);
  const delta = artifact.has_line_delta || added || removed ? `, +${added} -${removed}` : "";
  return `- \`${path}\` (${kind}${delta})`;
}

function formatTaskArtifacts(taskArtifacts = {}) {
  const artifacts = Array.isArray(taskArtifacts.artifacts) ? taskArtifacts.artifacts : [];
  if (!artifacts.length) return "";
  const summary = taskArtifacts.summary || {};
  const summaryLine = Number(summary.files || 0)
    ? `${Number(summary.files)} file(s), +${Number(summary.added_lines || 0)} -${Number(summary.removed_lines || 0)}.`
    : "";
  return [summaryLine, ...artifacts.map(artifactLine).filter(Boolean)].filter(Boolean).join("\n");
}

function formatResolvedBlockers(resolvedBlockers = []) {
  return resolvedBlockers.map((blocker) => {
    const latest = blocker.latest_execute_run || {};
    const outcome = clip(latest.finalText || latest.summary || latest.details || "");
    const paths = (blocker.artifacts || []).map((artifact) => artifact.display_path || artifact.path).filter(Boolean);
    return [
      `### ${blocker.task_key || blocker.id}: ${blocker.title}`,
      `Stage: ${blocker.stage || "done"}`,
      latest.id ? `Latest execute run: \`${latest.id}\` (${latest.status || latest.process_status || "unknown"})` : "",
      outcome ? `Outcome:\n${outcome}` : "",
      paths.length ? `Changed paths: ${paths.map((path) => `\`${path}\``).join(", ")}` : "",
    ].filter(Boolean).join("\n\n");
  }).join("\n\n");
}

function parseResult(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function formatVerificationEvidence(evidence = []) {
  if (!Array.isArray(evidence) || !evidence.length) return "";
  return evidence.map((row) => [
    row.kind || "evidence",
    row.command_or_url || "",
    row.exit_code_or_status || row.status || "",
    clip(row.snippet || row.evidence || "", 1_000),
    row.reason || "",
  ].filter(Boolean).join(" — ")).map((line) => `- ${line}`).join("\n");
}

function formatReviewEvidence(priorRun, execution) {
  if (!priorRun && !execution) return "";
  const result = parseResult(priorRun?.result_json);
  const finalOutput = clip(
    execution?.finalText || result.final_text || priorRun?.details || priorRun?.summary || priorRun?.error_text || "",
    MAX_REVIEW_TEXT_CHARS,
  );
  const verification = formatVerificationEvidence(result.verification_evidence);
  return [
    priorRun?.id || execution?.runId ? `Owner run: \`${priorRun?.id || execution?.runId}\`` : "",
    priorRun?.status ? `Status: ${priorRun.status}` : "",
    priorRun?.decision || result.decision ? `Decision: ${priorRun?.decision || result.decision}` : "",
    priorRun?.summary || result.summary ? `Summary: ${priorRun?.summary || result.summary}` : "",
    finalOutput ? `Final output:\n${finalOutput}` : "",
    verification ? `Verification evidence:\n${verification}` : "",
  ].filter(Boolean).join("\n\n");
}

function resultContract(mode) {
  const stage = ["plan", "execute", "review"].includes(mode) ? mode : "execute";
  const decision = stage === "review" ? "approve" : "advance";
  const allowed = stage === "review" ? "approve or reject" : "advance, pause, or block";
  const shape = {
    schema: "worklab.v2",
    stage,
    decision,
    summary: "Short outcome.",
    details: "Useful task-owned detail.",
    final_text: "Concise human-facing final comment.",
    artifacts: {},
    artifact_entries: [],
    blocking_issues: [],
    pending_actions: [],
    questions: [],
    subtasks: [],
    parent_review_policy: null,
    memory_candidates: [],
    verification_evidence: [],
  };
  const missingRequiredFields = (WORKLAB_RESULT_JSON_SCHEMA.required || [])
    .filter((field) => !Object.hasOwn(shape, field));
  if (missingRequiredFields.length) {
    throw new Error(`ACP task result example is missing required Worklab fields: ${missingRequiredFields.join(", ")}`);
  }
  return [
    "Finish with exactly one terminal JSON object and no prose around it.",
    `Allowed decision values for this ${stage} run: ${allowed}.`,
    "Keep fields that do not apply empty.",
    "```json",
    JSON.stringify(shape, null, 2),
    "```",
  ].join("\n");
}

function clientOwnedProjectContext(project, effectiveWorkdir) {
  if (!project) return "";
  return [
    project.name ? `Name: ${project.name}` : "",
    project.slug ? `Slug: ${project.slug}` : "",
    project.description ? `Description:\n${project.description}` : "",
    project.context ? `Context:\n${project.context}` : "",
    effectiveWorkdir ? `Task workspace: \`${effectiveWorkdir}\`` : "",
  ].filter(Boolean).join("\n\n");
}

function clientOwnedRepositoryContext(repositoryInstructions) {
  if (!repositoryInstructions?.content) return "";
  return [
    repositoryInstructions.path ? `Source: \`${repositoryInstructions.path}\`` : "",
    repositoryInstructions.truncated
      ? "This repository guidance was clipped; rely only on the included content."
      : "",
    repositoryInstructions.content,
  ].filter(Boolean).join("\n\n");
}

function clientOwnedPinnedKnowledge(entries = []) {
  return entries.map((entry) => [
    entry?.title ? `### ${entry.title}` : "### Knowledge",
    entry?.body || "",
  ].filter(Boolean).join("\n\n")).join("\n\n");
}

function clientOwnedAcpSystemPrompt(setup = {}, mode = "execute") {
  const boundary = [
    "Worklab owns this ACP profile's prompt configuration and supplies the persona and context below.",
    "Worklab does not supply tools, MCP servers, skill packages, subagents, delegation facilities, filesystem access, or terminal access over this ACP connection. Use only capabilities independently owned and advertised by the external ACP agent.",
  ].join("\n\n");
  return [
    "# Worklab ACP client context",
    boundary,
    section("Role", setup.agent?.instructions || ""),
    section("Run", [
      `Mode: ${mode}`,
      setup.effectiveWorkdir ? `Task workspace: \`${setup.effectiveWorkdir}\`` : "",
    ].filter(Boolean).join("\n")),
    section("Project", clientOwnedProjectContext(setup.project, setup.effectiveWorkdir)),
    section("Repository guidance", clientOwnedRepositoryContext(setup.repositoryInstructions)),
    section("Pinned knowledge", clientOwnedPinnedKnowledge(setup.pinnedKb)),
    section("Memory", setup.memory || ""),
    section("Learned memory", setup.learningMemoryContext || ""),
    section("Recent journal", setup.journalTail || ""),
    section("Resume context", setup.resumeContext || ""),
    section("Webhook trigger", setup.webhookTrigger ? JSON.stringify(setup.webhookTrigger, null, 2) : ""),
  ].filter(Boolean).join("\n\n");
}

function localAttachmentPath(attachment, { dataDir, effectiveWorkdir } = {}) {
  if (!attachment || attachment.kind === "upload") {
    return attachmentStoredFilePath({ dataDir, attachment });
  }
  const absolutePath = text(attachment.absolute_path);
  if (absolutePath && isAbsolute(absolutePath)) return absolutePath;
  const pathText = text(attachment.path_text);
  if (!pathText || pathText.includes("\0")) return null;
  if (isAbsolute(pathText)) return pathText;
  return effectiveWorkdir ? resolve(effectiveWorkdir, pathText) : null;
}

function attachmentResourceLink(attachment, options = {}) {
  const path = localAttachmentPath(attachment, options);
  if (!path || !isAbsolute(path) || path.includes("\0")) return null;
  const name = text(attachment.label)
    || text(attachment.filename)
    || basename(path)
    || "attachment";
  return {
    type: "resource_link",
    uri: pathToFileURL(path).href,
    name,
    ...(text(attachment.mime_type) ? { mimeType: text(attachment.mime_type) } : {}),
    ...(Number.isSafeInteger(attachment.size_bytes) && attachment.size_bytes >= 0
      ? { size: attachment.size_bytes }
      : {}),
  };
}

export function collectAcpTaskResourceLinks({ task, comments = [], dataDir, effectiveWorkdir } = {}) {
  const attachments = [
    ...(Array.isArray(task?.attachments) ? task.attachments : []),
    ...comments.flatMap((comment) => Array.isArray(comment?.attachments) ? comment.attachments : []),
  ];
  const seen = new Set();
  const links = [];
  for (const attachment of attachments) {
    const link = attachmentResourceLink(attachment, { dataDir, effectiveWorkdir });
    if (!link || seen.has(link.uri)) continue;
    seen.add(link.uri);
    links.push(link);
  }
  return links;
}

function sanitizedAgent(agent = {}) {
  return {
    ...agent,
    description: null,
    instructions: "",
    skills_allowlist: "[]",
    skills_allowlist_mode: "custom",
    mcp_allowlist: "[]",
    mcp_allowlist_mode: "custom",
    builtin_allowlist: "[]",
    builtin_allowlist_mode: "custom",
    subagent_mode: "advisory",
    require_human_approval: 0,
    tool_risk_tiers_json: "{}",
    fallback_chain_json: "[]",
  };
}

function sanitizedProject(project) {
  if (!project) return null;
  return {
    id: project.id,
    slug: project.slug,
    name: project.name,
  };
}

function sanitizedTask(task = {}) {
  return {
    id: task.id,
    task_key: task.task_key || null,
    title: task.title || "",
    instructions: task.instructions || "",
    stage: task.stage || null,
    stage_reason: task.stage_reason || null,
    plan_body: task.plan_body || "",
    plan_source_run_id: task.plan_source_run_id || null,
    plan_updated_by: task.plan_updated_by || null,
    plan_updated_at: task.plan_updated_at || null,
    attachments: Array.isArray(task.attachments) ? task.attachments : [],
  };
}

function sanitizedPriorRun(priorRun) {
  if (!priorRun) return null;
  return {
    id: priorRun.id || null,
    mode: priorRun.mode || null,
    stage: priorRun.stage || null,
    agent_name: priorRun.agent_name || null,
    status: priorRun.status || null,
    process_status: priorRun.process_status || null,
    decision: priorRun.decision || null,
    summary: priorRun.summary || null,
    details: priorRun.details || null,
    error_text: priorRun.error_text || null,
    started_at: priorRun.started_at || null,
    ended_at: priorRun.ended_at || null,
  };
}

function sanitizedExecution(execution) {
  if (!execution) return null;
  return {
    runId: execution.runId || null,
    agentName: execution.agentName || "unknown",
    finalText: execution.finalText || "",
    numTurns: Number(execution.numTurns || 0),
    durationMs: Number(execution.durationMs || 0),
  };
}

function sanitizedAcpProfile(profile) {
  if (!profile) return null;
  return {
    id: profile.id,
    agentName: profile.agentName,
    driver: profile.driver,
    configurationOwner: profile.configurationOwner,
    workspaceOwner: profile.workspaceOwner,
    mcpOwner: profile.mcpOwner,
    canonicalWorkspace: profile.canonicalWorkspace || null,
  };
}

function sanitizedArtifact(artifact = {}) {
  return {
    path: artifact.path || null,
    display_path: artifact.display_path || artifact.path || null,
    kind: artifact.kind || null,
    status: artifact.status || null,
    added_lines: Number(artifact.added_lines || 0),
    removed_lines: Number(artifact.removed_lines || 0),
    has_line_delta: !!artifact.has_line_delta,
    run_ids: Array.isArray(artifact.run_ids) ? artifact.run_ids : [],
    first_run_id: artifact.first_run_id || null,
    last_run_id: artifact.last_run_id || null,
    first_seen_at: artifact.first_seen_at || null,
    last_seen_at: artifact.last_seen_at || null,
  };
}

function sanitizedTaskArtifacts(taskArtifacts = {}) {
  return {
    artifacts: Array.isArray(taskArtifacts.artifacts)
      ? taskArtifacts.artifacts.map(sanitizedArtifact)
      : [],
    summary: taskArtifacts.summary && typeof taskArtifacts.summary === "object"
      ? { ...taskArtifacts.summary }
      : {},
  };
}

function sanitizedResolvedBlockers(resolvedBlockers = []) {
  return resolvedBlockers.map((blocker) => ({
    id: blocker.id || null,
    task_key: blocker.task_key || null,
    title: blocker.title || "",
    stage: blocker.stage || null,
    stage_reason: blocker.stage_reason || null,
    latest_execute_run: blocker.latest_execute_run ? {
      id: blocker.latest_execute_run.id || null,
      status: blocker.latest_execute_run.status || null,
      process_status: blocker.latest_execute_run.process_status || null,
      decision: blocker.latest_execute_run.decision || null,
      summary: blocker.latest_execute_run.summary || null,
      details: blocker.latest_execute_run.details || null,
      finalText: blocker.latest_execute_run.finalText || "",
    } : null,
    artifacts: Array.isArray(blocker.artifacts) ? blocker.artifacts.map(sanitizedArtifact) : [],
    artifact_summary: blocker.artifact_summary && typeof blocker.artifact_summary === "object"
      ? { ...blocker.artifact_summary }
      : {},
  }));
}

export function stripWorklabConfigurationForAgentOwnedAcp(setup = {}) {
  return {
    ...setup,
    agent: sanitizedAgent(setup.agent),
    task: sanitizedTask(setup.task),
    project: sanitizedProject(setup.project),
    sourceWorkdir: null,
    worktree: null,
    repositoryInstructions: null,
    repositoryGitRoot: null,
    qaOutputDir: null,
    resumeContext: "",
    skills: [],
    skillDirs: [],
    memory: "",
    learningMemories: [],
    learningMemoryContext: "",
    journalTail: "",
    mcpServers: {},
    allowedTools: [],
    disallowedTools: [],
    capabilityRestrictions: ["configuration_owned_by_acp_agent"],
    pinnedKb: [],
    settings: {},
    delegation: null,
    nativeSubagents: null,
    webhookTrigger: null,
  };
}

export function buildAgentOwnedAcpTaskInput({
  setup,
  acpProfile,
  mode,
  runtimeDateContext,
  currentRunComments = [],
  priorRuns = [],
  priorRun = null,
  execution = null,
  taskArtifacts = {},
  resolvedBlockers = [],
  dataDir = null,
} = {}) {
  const comments = Array.isArray(setup?.commentRows) ? setup.commentRows : [];
  const currentIds = new Set(currentRunComments.map((comment) => comment?.id).filter(Boolean));
  const olderComments = comments.filter((comment) => !currentIds.has(comment?.id));
  const task = setup?.task || {};
  const taskBody = [
    `Title: ${task.title || "(untitled task)"}`,
    task.instructions ? `Instructions:\n${task.instructions}` : "Instructions: (none)",
    task.stage_reason ? `Stage reason: ${task.stage_reason}` : "",
  ].filter(Boolean).join("\n\n");
  const runBody = [
    `Mode: ${mode}`,
    `Workflow stage: ${task.stage || mode}`,
    setup?.effectiveWorkdir ? `Workspace: \`${setup.effectiveWorkdir}\`` : "",
  ].filter(Boolean).join("\n");
  const sections = [
    "# Worklab task handoff",
    section("Run", runBody),
    section("Runtime context", runtimeContext(runtimeDateContext)),
    section("Task", taskBody),
    section("Current run guidance", formatComments(currentRunComments)),
    section("Task comment history", formatComments(olderComments)),
    section("Saved plan", formatSavedPlan(task)),
    section("Prior run outcomes", formatPriorRuns(priorRuns)),
    section("Current review evidence", formatReviewEvidence(priorRun, execution)),
    section("Task artifacts", formatTaskArtifacts(taskArtifacts)),
    section("Resolved task dependencies", formatResolvedBlockers(resolvedBlockers)),
    section("Required Worklab v2 result", resultContract(mode)),
  ].filter(Boolean);
  const promptText = sections.join("\n\n");
  const safeTaskArtifacts = sanitizedTaskArtifacts(taskArtifacts);
  const safeResolvedBlockers = sanitizedResolvedBlockers(resolvedBlockers);
  const resourceLinks = collectAcpTaskResourceLinks({
    task,
    comments,
    dataDir,
    effectiveWorkdir: setup?.effectiveWorkdir,
  });
  const safeSetup = stripWorklabConfigurationForAgentOwnedAcp(setup);
  return {
    ...safeSetup,
    acpProfile: sanitizedAcpProfile(acpProfile),
    mode,
    systemPrompt: "",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: promptText },
        ...resourceLinks,
      ],
    }],
    currentRunComments,
    priorRuns,
    priorRun: sanitizedPriorRun(priorRun),
    priorEvents: [],
    execution: sanitizedExecution(execution),
    taskArtifacts: safeTaskArtifacts,
    resolvedBlockers: safeResolvedBlockers,
    learningMemories: [],
    runtimeDateContext,
    allowedTools: [],
    disallowedTools: [],
    toolPolicy: null,
    promptDiagnostics: {
      prefixHash: null,
      promptChars: promptText.length,
      project: safeSetup.project ? {
        id: safeSetup.project.id,
        slug: safeSetup.project.slug,
        contextHash: safeSetup.projectContextHash || null,
        workdir: safeSetup.effectiveWorkdir || null,
        workspaceMode: safeSetup.workspaceMode || "direct",
        sourceWorkdir: null,
      } : null,
      repositoryInstructions: null,
      repositoryGitRoot: null,
      workspaceMode: safeSetup.workspaceMode || "direct",
      sourceWorkdir: null,
      worktree: null,
      toolCount: { skills: 0, builtin: 0, mcp: 0 },
      artifacts: safeTaskArtifacts.summary || null,
      resolvedBlockers: safeResolvedBlockers.length,
      learningMemories: 0,
      resumeContext: false,
      planning: null,
      nativeSubagents: null,
      contextCacheHit: false,
      acp: {
        profileId: acpProfile?.id || null,
        configurationOwner: "agent",
      },
    },
  };
}

/**
 * Client-owned ACP profiles keep Worklab-authored persona and context, while
 * projecting only the capabilities the ACP runtime actually supplies. This
 * prevents the ordinary Worklab prompt and run payload from promising local
 * tools, MCP servers, skills, or subagents that cannot cross this connection.
 */
export function buildClientOwnedAcpTaskInput(options = {}) {
  const { setup = {}, acpProfile, mode = "execute" } = options;
  const base = buildAgentOwnedAcpTaskInput(options);
  const systemPrompt = clientOwnedAcpSystemPrompt(setup, mode);
  const messageText = base.messages?.[0]?.content?.find?.((block) => block?.type === "text")?.text || "";
  return {
    ...base,
    agent: {
      ...base.agent,
      description: setup.agent?.description || null,
      instructions: setup.agent?.instructions || "",
    },
    project: setup.project || null,
    sourceWorkdir: setup.sourceWorkdir || null,
    worktree: setup.worktree || null,
    repositoryInstructions: setup.repositoryInstructions || null,
    repositoryGitRoot: setup.repositoryGitRoot || null,
    resumeContext: setup.resumeContext || "",
    memory: setup.memory || "",
    learningMemories: Array.isArray(setup.learningMemories) ? setup.learningMemories : [],
    learningMemoryContext: setup.learningMemoryContext || "",
    journalTail: setup.journalTail || "",
    pinnedKb: Array.isArray(setup.pinnedKb) ? setup.pinnedKb : [],
    webhookTrigger: setup.webhookTrigger || null,
    capabilityRestrictions: ["acp_client_services_unavailable"],
    acpProfile: sanitizedAcpProfile(acpProfile),
    systemPrompt,
    promptDiagnostics: {
      ...base.promptDiagnostics,
      promptChars: systemPrompt.length + messageText.length,
      project: setup.project ? {
        id: setup.project.id,
        slug: setup.project.slug,
        contextHash: setup.projectContextHash || null,
        workdir: setup.effectiveWorkdir || null,
        workspaceMode: setup.workspaceMode || "direct",
        sourceWorkdir: setup.sourceWorkdir || null,
      } : null,
      repositoryInstructions: setup.repositoryInstructions ? {
        path: setup.repositoryInstructions.path,
        hash: setup.repositoryInstructions.hash,
        truncated: !!setup.repositoryInstructions.truncated,
      } : null,
      repositoryGitRoot: setup.repositoryGitRoot || null,
      workspaceMode: setup.workspaceMode || "direct",
      sourceWorkdir: setup.sourceWorkdir || null,
      worktree: setup.worktree ? {
        branch: setup.worktree.branch || null,
        status: setup.worktree.status || null,
        runtime_workdir: setup.worktree.runtime_workdir || null,
      } : null,
      resumeContext: !!setup.resumeContext,
      acp: {
        profileId: acpProfile?.id || null,
        configurationOwner: "client",
      },
    },
  };
}
