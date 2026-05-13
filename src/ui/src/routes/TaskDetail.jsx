// §6.3 TaskDetail — deep view of one task.
// Two-column layout. Hero with StatusMenu + primary action cluster. Stuck-task
// Banner (§5.2). LiveRunPanel while streaming. Activity feed. Previous runs.
// Rail: Agents, Context, Tags, Actions.
// Error chip (§5.3) derived from last_run.status === 'error'.

import { useEffect, useMemo, useRef, useState, useCallback } from "preact/hooks";
import { api } from "../lib/api.js";
import { useSSE } from "../lib/useSSE.js";
import { useRunStream } from "../lib/useRunStream.js";
import { useThrottledCallback } from "../lib/useThrottledCallback.js";
import { pageIsVisible, useAppResume } from "../lib/pageVisibility.js";
import { pushToast } from "../lib/toast.js";
import { useGlobalShortcuts } from "../lib/useGlobalShortcuts.js";
import { agentDisplayName, taskDisplayKey, taskRecoveryLabel, taskRouteId } from "../lib/display.js";
import { optimisticTaskDetailRunStarted, selectHighlightedRunId } from "./taskDetailRuns.js";

import { AppShell, MobilePillRow, MobileTopbar } from "../components/AppShell.jsx";
import { StatusPill } from "../components/primitives/StatusPill.jsx";
import { Button } from "../components/primitives/Button.jsx";
import { IconButton } from "../components/primitives/IconButton.jsx";
import { Icon } from "../components/Icon.jsx";
import { Card } from "../components/Card.jsx";
import { Banner } from "../components/Banner.jsx";
import { LoadingState } from "../components/LoadingState.jsx";
import { EmptyState } from "../components/EmptyState.jsx";
import { EntityBadge } from "../components/EntityBadge.jsx";
import { FormSection } from "../components/FormSection.jsx";
import { LiveRunPanel } from "../components/LiveRunPanel.jsx";
import { StatusMenu } from "../components/StatusMenu.jsx";
import { Textarea } from "../components/primitives/Textarea.jsx";
import { MentionableTextarea } from "../components/MentionableTextarea.jsx";
import { AttachmentChips } from "../components/AttachmentChips.jsx";
import { Checkbox } from "../components/primitives/Checkbox.jsx";
import { DetailHead, InlineHead, SectionMarker, Toolbar } from "../components/layout/index.js";
import { StructuredContent } from "../components/StructuredContent.jsx";
import { AgentLink } from "../components/AgentLink.jsx";
import { navigateHash } from "../lib/navigation.js";
import { mergeAgentReferenceMentions } from "../lib/agentLinks.js";
import { attachmentPayload, imageFilesFromTransfer, transferHasFiles, uploadedAttachmentDraft } from "../lib/attachments.js";
import { ActivityRailDot, buildActivity, commentAuthorLabel } from "./task-detail/activity.jsx";
import { readTaskDetailCache, writeTaskDetailCache } from "./task-detail/summaryCache.js";
import {
  TASK_DETAIL_SECTIONS,
  formatActivityTime,
  formatDate,
  projectRouteId,
} from "./task-detail/format.js";
import { RunCard } from "./task-detail/RunCards.jsx";
import { RunInputPreviewModal } from "./task-detail/RunInputPreviewModal.jsx";
import { formatRunPreviewForCopy } from "./task-detail/runPreview.js";
import { TaskDetailModals } from "./task-detail/TaskDetailModals.jsx";
import {
  TaskAutomationsCard,
  TaskParentReference,
  TaskPendingQuestionsCard,
  TaskPlanCard,
  TaskSubtasksCard,
  TaskWorkflowMeta,
} from "./task-detail/WorkflowCards.jsx";
import { TaskRail } from "./task-detail/TaskRail.jsx";

export {
  clearTaskDetailCache,
  readTaskDetailCache,
  taskDetailDataFromTaskSummary,
  writeTaskDetailCache,
  writeTaskDetailSummaryCache,
} from "./task-detail/summaryCache.js";

const TASK_DETAIL_INITIAL_RUN_LIMIT = 20;

export function TaskDetail({ id, runParam = null }) {
  const [data, setData] = useState(() => readTaskDetailCache(id));
  const [agents, setAgents] = useState([]);
  const [newComment, setNewComment] = useState("");
  const [commentAttachments, setCommentAttachments] = useState([]);
  const [commentAttachmentUploading, setCommentAttachmentUploading] = useState(false);
  const [commentAttachmentError, setCommentAttachmentError] = useState("");
  const [commentRerun, setCommentRerun] = useState(true);
  const [highlightedRunId, setHighlightedRunId] = useState(runParam);
  const [expandedRunIds, setExpandedRunIds] = useState(() => new Set());
  const [runError, setRunError] = useState(null);
  const [runStarting, setRunStarting] = useState(false);
  const [statusModal, setStatusModal] = useState(null); // pending transition
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [commentDeleteTarget, setCommentDeleteTarget] = useState(null);
  const [commentDeleting, setCommentDeleting] = useState(false);
  const [commentSaving, setCommentSaving] = useState(false);
  const [showOlderActivity, setShowOlderActivity] = useState(false);
  const [runsNextCursor, setRunsNextCursor] = useState(() => readTaskDetailCache(id)?.runs_next_cursor || null);
  const [runHistoryLoading, setRunHistoryLoading] = useState(false);
  const [instructionsExpanded, setInstructionsExpanded] = useState(false);
  const [planDraft, setPlanDraft] = useState("");
  const [planEditing, setPlanEditing] = useState(false);
  const [planSaving, setPlanSaving] = useState(false);
  const [taskAutomations, setTaskAutomations] = useState(null);
  const [automationsLoading, setAutomationsLoading] = useState(false);
  const [runPreviewOpen, setRunPreviewOpen] = useState(false);
  const [runPreview, setRunPreview] = useState(null);
  const [runPreviewLoading, setRunPreviewLoading] = useState(false);
  const [runPreviewError, setRunPreviewError] = useState(null);
  const runTargetRefs = useRef(new Map());
  const lastScrolledRunRef = useRef(null);
  const commentDeletingRef = useRef(false);
  const reloadAbortRef = useRef(null);
  const automationsAbortRef = useRef(null);
  const hiddenDetailReloadRef = useRef(false);
  const hiddenAutomationsReloadRef = useRef(false);
  const fullRunHistoryLoadedRef = useRef(false);

  const reload = useCallback(() => {
    reloadAbortRef.current?.abort?.();
    const controller = new AbortController();
    reloadAbortRef.current = controller;
    const taskRequest = fullRunHistoryLoadedRef.current
      ? api.getTask(id, { runs: "full" }, { signal: controller.signal })
      : api.getTask(id, { runs: "summary", run_limit: String(TASK_DETAIL_INITIAL_RUN_LIMIT) }, { signal: controller.signal });
    return taskRequest
      .then((nextData) => {
        if (controller.signal.aborted) return;
        writeTaskDetailCache(nextData);
        setData(nextData);
        setRunsNextCursor(nextData?.runs_next_cursor || null);
      })
      .catch((err) => {
        if (err?.name === "AbortError") return;
        const cached = readTaskDetailCache(id);
        setData(cached || { notFound: true });
        setRunsNextCursor(cached?.runs_next_cursor || null);
      });
  }, [id]);
  const reloadAutomations = useCallback(() => {
    automationsAbortRef.current?.abort?.();
    const controller = new AbortController();
    automationsAbortRef.current = controller;
    setAutomationsLoading(true);
    api.listTaskAutomations(id, { signal: controller.signal })
      .then((response) => { if (!controller.signal.aborted) setTaskAutomations(response.automations || []); })
      .catch((err) => { if (err?.name !== "AbortError") setTaskAutomations([]); })
      .finally(() => { if (!controller.signal.aborted) setAutomationsLoading(false); });
  }, [id]);
  const reloadSoon = useThrottledCallback(reload, 100);
  const reloadAutomationsSoon = useThrottledCallback(reloadAutomations, 100);
  const refreshOnResume = useCallback(() => {
    if (!pageIsVisible()) return;
    hiddenDetailReloadRef.current = false;
    hiddenAutomationsReloadRef.current = false;
    reloadSoon();
    reloadAutomationsSoon();
  }, [reloadAutomationsSoon, reloadSoon]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { reloadAutomations(); }, [reloadAutomations]);
  useEffect(() => {
    const controller = new AbortController();
    api.listAgents({ view: "summary" }, { signal: controller.signal }).then((r) => setAgents(r.agents || [])).catch((err) => {
      if (err?.name !== "AbortError") setAgents([]);
    });
    return () => controller.abort();
  }, []);
  useEffect(() => () => {
    reloadAbortRef.current?.abort?.();
    automationsAbortRef.current?.abort?.();
  }, []);
  useAppResume(refreshOnResume);
  useEffect(() => {
    const cached = readTaskDetailCache(id);
    if (cached) setData(cached);
    fullRunHistoryLoadedRef.current = false;
    setRunsNextCursor(cached?.runs_next_cursor || null);
    setRunHistoryLoading(false);
    setHighlightedRunId(runParam || null);
    setExpandedRunIds(new Set());
    setRunError(null);
    setRunStarting(false);
    setShowOlderActivity(false);
    setPlanEditing(false);
    setPlanDraft("");
    setTaskAutomations(null);
    setNewComment("");
    setCommentAttachments([]);
    setCommentAttachmentError("");
    setCommentAttachmentUploading(false);
    setCommentRerun(true);
    setCommentDeleteTarget(null);
    setCommentDeleting(false);
    commentDeletingRef.current = false;
    setRunPreviewOpen(false);
    setRunPreview(null);
    setRunPreviewError(null);
    setRunPreviewLoading(false);
  }, [id, runParam]);

  useEffect(() => {
    const currentTask = data?.task;
    if (!currentTask || planEditing) return;
    setPlanDraft(currentTask.plan_body || "");
  }, [data?.task?.id, data?.task?.plan_body, planEditing]);

  useSSE("global", (evt) => {
    const visible = pageIsVisible();
    const currentTask = data?.task;
    const matchesCurrentTask = (value) => Boolean(value)
      && (value === id || value === currentTask?.id || value === currentTask?.task_key);
    const taskChanged = matchesCurrentTask(evt.id) || matchesCurrentTask(evt.taskKey);
    const runChanged = (matchesCurrentTask(evt.taskId) || matchesCurrentTask(evt.taskKey))
      && (evt.type === "run_started" || evt.type === "run_ended");
    const automationChanged = (matchesCurrentTask(evt.taskId) || matchesCurrentTask(evt.taskKey))
      && String(evt.type || "").startsWith("automation_");
    if (taskChanged || runChanged || automationChanged) {
      if (visible) reloadSoon();
      else hiddenDetailReloadRef.current = true;
    }
    if (automationChanged || runChanged) {
      if (visible) reloadAutomationsSoon();
      else hiddenAutomationsReloadRef.current = true;
    }
    if (evt.type === "run_started" && (matchesCurrentTask(evt.taskId) || matchesCurrentTask(evt.taskKey))) {
      setHighlightedRunId(evt.runId);
      setRunError(null);
    }
  });

  useEffect(() => {
    const next = selectHighlightedRunId(data?.runs || [], highlightedRunId, {
      preserveMissingActive: Boolean(highlightedRunId),
    });
    if (next !== highlightedRunId) setHighlightedRunId(next);
  }, [data, highlightedRunId]);

  useEffect(() => {
    if (!highlightedRunId) return;
    setExpandedRunIds((current) => {
      if (current.has(highlightedRunId)) return current;
      return new Set([...current, highlightedRunId]);
    });
  }, [highlightedRunId]);

  const task = data?.task;
  const operationTaskId = task?.id || id;
  const currentTaskRouteId = task ? taskRouteId(task) : encodeURIComponent(id);
  const taskKeyLabel = taskDisplayKey(task || id);
  const isTeamRoot = Boolean(task?.is_team_root);
  const canEditTask = task && !isTeamRoot;
  const canChangeTaskStatus = task && !isTeamRoot;
  const runs = data?.runs || [];
  const comments = data?.comments || [];
  const mentions = data?.mentions || null;
  const resolvedMentions = useMemo(() => mergeAgentReferenceMentions(mentions, agents), [mentions, agents]);
  const stage = task?.stage || "plan";
  const taskTeamRouteId = task?.team?.slug || task?.team_id || "";
  const taskTeamDisplay = task?.team?.name || (taskTeamRouteId ? "Unknown" : "");
  const taskGoalBadgeLabel = task?.project?.name ? `${task.project.name} goal` : "Open goal";
  const taskGoalBadgeTitle = task?.goal_contract?.objective || task?.goal_status_reason || taskGoalBadgeLabel;

  const loadFullRunHistory = useCallback(async () => {
    if (!operationTaskId || runHistoryLoading) return;
    setRunHistoryLoading(true);
    try {
      const response = await api.listTaskRuns(operationTaskId, { view: "full" });
      const nextRuns = Array.isArray(response?.runs) ? response.runs : [];
      fullRunHistoryLoadedRef.current = true;
      setData((current) => {
        if (!current) return current;
        const nextData = { ...current, runs: nextRuns, runs_next_cursor: null };
        writeTaskDetailCache(nextData);
        return nextData;
      });
      setRunsNextCursor(null);
      setShowOlderActivity(true);
    } catch (err) {
      pushToast(`Could not load run history: ${err.message}`, { variant: "error" });
    } finally {
      setRunHistoryLoading(false);
    }
  }, [operationTaskId, runHistoryLoading]);
  const automationSummary = task?.automation_summary || {};
  const hasTaskSchedules = Number(automationSummary.count || 0) > 0;
  const hasEnabledSchedule = Number(automationSummary.enabled_count || 0) > 0;
  const runningRun = runs.find((r) => (r.process_status || r.status) === "running") || null;
  const statusMenuState = runningRun ? "running" : stage;
  const lastFinishedRun = runs.find((r) => (r.process_status || r.status) && (r.process_status || r.status) !== "running") || null;
  const lastRunState = lastFinishedRun?.process_status || lastFinishedRun?.status;
  const hasLastRunError = !runningRun && (lastRunState === "failed" || lastRunState === "error" || lastRunState === "abandoned");
  const pendingQuestions = Array.isArray(task?.pending_questions) ? task.pending_questions : [];
  const interruptedStage = ["plan", "execute", "review"].includes(lastFinishedRun?.stage)
    ? lastFinishedRun.stage
    : (pendingQuestions.length > 0 ? "plan" : "execute");
  const recoveryLabel = taskRecoveryLabel(task);
  const recoveryDetail = recoveryLabel
    ? `${task?.last_run?.recovery?.subkind || "Provider"} interruption; retry is active.`
    : null;
  // §5.2 stuck-task: requires backend is_locked field. Until it ships, we do
  // NOT render the banner (prevents false positives).
  const showStuckBanner =
    task?.running_run_id && task?.is_locked === false;
  const runningRunStream = useRunStream(runningRun?.id || null, {
    subscribe: Boolean(runningRun),
    initialEventLimit: 10,
    maxEvents: 10,
  });

  useEffect(() => {
    if (stage === "done" && runError) setRunError(null);
  }, [runError, stage]);

  const activity = useMemo(
    () => buildActivity({ comments, runs }),
    [comments, runs]
  );
  const visibleActivity = showOlderActivity ? activity : activity.slice(0, 12);
  const displayActivity = useMemo(
    () => runningRun
      ? visibleActivity.filter((item) => !(item.type === "run" && item.run?.id === runningRun.id))
      : visibleActivity,
    [runningRun, visibleActivity],
  );

  function renderCommentAuthor(item) {
    const agentName = item.authorType === "agent" ? item.authorId || item.author?.id : null;
    if (agentName) {
      return (
        <AgentLink name={agentName} label={commentAuthorLabel(item)} agents={agents} badge={false} class="activity-author-name agent" />
      );
    }
    return <span class={`activity-author-badge ${item.authorType || "human"}`}>{commentAuthorLabel(item)}</span>;
  }

  const targetedRunExpanded = Boolean(
    runParam && (runningRun?.id === runParam || expandedRunIds.has(runParam)),
  );
  const runActivityIndex = useMemo(() => {
    if (!runParam || runningRun?.id === runParam) return -1;
    return activity.findIndex((item) => item.type === "run" && item.run?.id === runParam);
  }, [activity, runParam, runningRun?.id]);

  const unresolvedBlockedBy = useMemo(
    () => (task?.blocked_by || []).filter((entry) => (entry.stage || "plan") !== "done"),
    [task],
  );

  useEffect(() => {
    if (!runParam || showOlderActivity || runningRun?.id === runParam) return;
    if (runActivityIndex >= 12) setShowOlderActivity(true);
  }, [runParam, runActivityIndex, runningRun?.id, showOlderActivity]);

  useEffect(() => {
    if (!runParam || !task?.id || !targetedRunExpanded) return undefined;
    const scrollKey = `${task.id}:${runParam}`;
    if (lastScrolledRunRef.current === scrollKey) return undefined;
    const target = runTargetRefs.current.get(runParam);
    if (!target) return undefined;
    const frame = requestAnimationFrame(() => {
      const currentTarget = runTargetRefs.current.get(runParam);
      if (!currentTarget) return;
      lastScrolledRunRef.current = scrollKey;
      currentTarget.scrollIntoView({ block: "center", inline: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [displayActivity, runParam, showOlderActivity, targetedRunExpanded, task?.id]);

  function toggleRun(runId, open) {
    setHighlightedRunId((current) => (open ? runId : current === runId ? null : current));
    setExpandedRunIds((s) => {
      const n = new Set(s);
      if (open) n.add(runId); else n.delete(runId);
      return n;
    });
  }

  function setRunTarget(runId, node) {
    if (!runId) return;
    if (node) runTargetRefs.current.set(runId, node);
    else runTargetRefs.current.delete(runId);
  }

  async function addComment(e) {
    e?.preventDefault?.();
    if (!newComment.trim() || commentSaving) return;
    setCommentSaving(true);
    try {
      const shouldRerun = commentRerun && !runningRun;
      const result = await api.addComment(operationTaskId, newComment.trim(), {
        rerun: shouldRerun,
        attachments: attachmentPayload(commentAttachments),
      });
      setNewComment("");
      setCommentAttachments([]);
      setCommentAttachmentError("");
      setCommentRerun(true);
      if (result?.rerun?.started) {
        if (result.rerun.runId) {
          setHighlightedRunId(result.rerun.runId);
          setExpandedRunIds((s) => new Set([...s, result.rerun.runId]));
        }
        setRunError(null);
        pushToast("Comment posted and run started", { variant: "success" });
      } else if (result?.rerun?.error) {
        pushToast(`Comment posted; rerun did not start: ${result.rerun.error.message}`, { variant: "error" });
      }
      reload();
    } catch (err) {
      pushToast(`Could not post comment: ${err.message}`, { variant: "error" });
    } finally {
      setCommentSaving(false);
    }
  }

  async function attachCommentImageFiles(files) {
    if (!files.length) return;
    setCommentAttachmentUploading(true);
    setCommentAttachmentError("");
    try {
      const uploads = [];
      for (const file of files) {
        const result = await api.uploadAttachment(file);
        const draftAttachment = uploadedAttachmentDraft(result.upload, file.name || "Clipboard image");
        if (draftAttachment) uploads.push(draftAttachment);
      }
      setCommentAttachments((current) => [...current, ...uploads]);
    } catch (err) {
      setCommentAttachmentError(err?.message || "Image upload failed");
    } finally {
      setCommentAttachmentUploading(false);
    }
  }

  async function handleCommentAttachmentPaste(event) {
    const files = imageFilesFromTransfer(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    await attachCommentImageFiles(files);
  }

  function handleCommentAttachmentDragOver(event) {
    if (!transferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  async function handleCommentAttachmentDrop(event) {
    if (!transferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    const files = imageFilesFromTransfer(event.dataTransfer);
    if (files.length === 0) {
      setCommentAttachmentError("Drop images to attach. Type or select local paths in the field.");
      return;
    }
    await attachCommentImageFiles(files);
  }

  function handlePendingQuestionsAnswered(result) {
    if (result?.rerun?.runId) {
      setHighlightedRunId(result.rerun.runId);
      setExpandedRunIds((s) => new Set([...s, result.rerun.runId]));
      setRunError(null);
    }
    reload();
  }

  async function savePlan() {
    setPlanSaving(true);
    try {
      await api.patchTask(operationTaskId, { plan_body: planDraft });
      setPlanEditing(false);
      reload();
      pushToast("Plan saved", { variant: "success" });
    } catch (err) {
      pushToast(`Plan save failed: ${err.message}`, { variant: "error" });
    } finally {
      setPlanSaving(false);
    }
  }

  function cancelPlanEdit() {
    setPlanDraft(task?.plan_body || "");
    setPlanEditing(false);
  }

  async function destroy() {
    try {
      await api.deleteTask(operationTaskId);
      pushToast("Task deleted", { variant: "success" });
      navigateHash("#/tasks");
    } catch (err) {
      pushToast(`Delete failed: ${err.message}`, { variant: "error" });
    }
  }

  async function deleteComment() {
    if (!commentDeleteTarget?.commentId || commentDeletingRef.current) return;
    commentDeletingRef.current = true;
    setCommentDeleting(true);
    try {
      await api.deleteComment(operationTaskId, commentDeleteTarget.commentId);
      setCommentDeleteTarget(null);
      reload();
      pushToast("Comment deleted", { variant: "success" });
    } catch (err) {
      if (err.status === 404 && err.code === "not_found") {
        setCommentDeleteTarget(null);
        reload();
        pushToast("Comment was already removed; activity refreshed", { variant: "info" });
        return;
      }
      pushToast(`Delete failed: ${err.message}`, { variant: "error" });
    } finally {
      commentDeletingRef.current = false;
      setCommentDeleting(false);
    }
  }

  async function runNow() {
    setRunError(null);
    setRunStarting(true);
    try {
      const r = await api.runTask(operationTaskId);
      const startedAt = Date.now();
      setHighlightedRunId(r.runId);
      setExpandedRunIds((s) => new Set([...s, r.runId]));
      setData((current) => {
        const nextData = optimisticTaskDetailRunStarted(current, { runId: r.runId, startedAt });
        if (nextData) writeTaskDetailCache(nextData);
        return nextData || current;
      });
      reload();
      pushToast("Run started", { variant: "success" });
    } catch (err) {
      setRunError(err.message);
      pushToast(`Run failed: ${err.message}`, { variant: "error" });
    } finally {
      setRunStarting(false);
    }
  }

  async function cancelRun() {
    try { await api.cancelTask(operationTaskId); pushToast("Run cancelled", { variant: "info" }); }
    catch (err) { setRunError(err.message); pushToast(`Cancel failed: ${err.message}`, { variant: "error" }); }
  }

  async function resetToExecute() {
    try {
      await api.patchTask(operationTaskId, { stage: "execute" });
      reload();
      pushToast("Reset to execute", { variant: "success" });
    } catch (err) {
      pushToast(`Reset failed: ${err.message}`, { variant: "error" });
    }
  }

  async function retryStuck() {
    setRunStarting(true);
    try {
      await api.patchTask(operationTaskId, { stage: "execute" });
      const r = await api.runTask(operationTaskId);
      const startedAt = Date.now();
      setHighlightedRunId(r.runId);
      setExpandedRunIds((s) => new Set([...s, r.runId]));
      setData((current) => {
        const nextData = optimisticTaskDetailRunStarted(current, { runId: r.runId, startedAt });
        if (nextData) writeTaskDetailCache(nextData);
        return nextData || current;
      });
      reload();
      pushToast("Run retried", { variant: "success" });
    } catch (err) {
      pushToast(`Retry failed: ${err.message}`, { variant: "error" });
    } finally {
      setRunStarting(false);
    }
  }

  async function applyStatusTransition(t) {
    try {
      if ((t.to === "execute" || t.to === "plan") && runningRun) {
        await runNow();
        return;
      }
      await api.patchTask(operationTaskId, { stage: t.to });
      reload();
      pushToast(`Stage → ${t.to}`, { variant: "success" });
    } catch (err) {
      pushToast(`Stage change failed: ${err.message}`, { variant: "error" });
    }
  }

  function onStatusChoose(t) {
    if (t.confirm) setStatusModal(t);
    else applyStatusTransition(t);
  }

  async function updateAssignee(role, value) {
    const nextValue = value || null;
    try {
      const response = await api.patchTask(operationTaskId, { [role]: nextValue });
      if (response?.task) {
        setData((current) => current?.task
          ? { ...current, task: { ...current.task, ...response.task } }
          : current);
      } else {
        setData((current) => current?.task
          ? { ...current, task: { ...current.task, [role]: nextValue } }
          : current);
      }
      pushToast("Assignment updated", { variant: "success" });
      reload();
    } catch (error) {
      pushToast(`Assignment failed: ${error.message}`, { variant: "error" });
    }
  }

  async function openRunPreview() {
    setRunPreviewOpen(true);
    setRunPreviewLoading(true);
    setRunPreviewError(null);
    setRunPreview(null);
    try {
      const response = await api.previewTaskRun(operationTaskId);
      setRunPreview(response.preview || null);
    } catch (error) {
      const message = error?.message || "Preview failed";
      setRunPreviewError(message);
      pushToast(`Preview failed: ${message}`, { variant: "error" });
    } finally {
      setRunPreviewLoading(false);
    }
  }

  async function copyRunPreview() {
    if (!runPreview) return;
    try {
      await navigator.clipboard.writeText(formatRunPreviewForCopy(runPreview));
      pushToast("Run input copied", { variant: "success" });
    } catch {
      pushToast("Copy failed", { variant: "error" });
    }
  }

  // §6.3 primary action cluster per stage
  const runnableStages = ["plan", "execute", "review"];
  const selectedAgent = stage === "review"
    ? task?.reviewer_agent
    : stage === "plan"
      ? (task?.planner_agent || task?.owner_agent)
      : task?.owner_agent;
  const runCopy = isTeamRoot ? {
    label: "Run lead cycle",
    title: "Lead cycle runs coordinate the team roster and create or assign project work.",
    missing: "Assign a team lead to run the lead cycle",
  } : {
    plan: {
      label: "Run plan",
      title: "Planner plans the task, falling back to owner when no planner is assigned.",
      missing: "Assign a planner or owner to run plan",
    },
    execute: {
      label: "Run work",
      title: "Owner performs the work. It moves to Review when a reviewer is assigned, otherwise Done.",
      missing: "Assign an owner to run work",
    },
    review: {
      label: "Run review",
      title: "Reviewer checks the latest work and approves to Done or rejects back to Execute.",
      missing: "Assign a reviewer to run review",
    },
  }[stage];
  const canRun = !runStarting && selectedAgent && runnableStages.includes(stage) && unresolvedBlockedBy.length === 0;
  const canPreviewRunInput = canEditTask && runnableStages.includes(stage) && !runningRun;
  const runDisabledReason = runStarting
    ? "Run is starting"
    : !selectedAgent
    ? (runCopy?.missing || "No run action in this stage")
    : unresolvedBlockedBy.length > 0
      ? `Blocked by ${unresolvedBlockedBy.map((entry) => entry.title).join(", ")}`
      : undefined;
  function renderPrimaryAction() {
    if (!task) return null;
    if (runningRun) {
      return (
        <Button variant="destructive" iconLeft={<Icon name="stop" size={13} />} onClick={cancelRun}>
          Cancel
        </Button>
      );
    }
    if (showStuckBanner) {
      return (
        <Button variant="primary" iconLeft={<Icon name="refresh-cw" size={13} />} onClick={retryStuck} disabled={runStarting}>
          {runStarting ? "Starting..." : "Retry"}
        </Button>
      );
    }
    if (isTeamRoot) {
      return (
        <Button
          variant="primary"
          iconLeft={<Icon name="play" size={13} />}
          onClick={runNow}
          disabled={!canRun}
          title={runDisabledReason || runCopy?.title}
        >
          {runStarting ? "Starting..." : runCopy.label}
        </Button>
      );
    }
    if (stage === "review" && !runningRun) {
      return (
        <>
          <Button
            variant="primary"
            iconLeft={<Icon name="play" size={13} />}
            onClick={runNow}
            disabled={!canRun}
            title={runDisabledReason || runCopy?.title}
          >
            {runStarting ? "Starting..." : runCopy.label}
          </Button>
          <Button variant="secondary" onClick={() => applyStatusTransition({ from: "review", to: "done" })}>
            Approve
          </Button>
          <Button variant="secondary" onClick={() => applyStatusTransition({ from: "review", to: "execute" })}>
            Request changes
          </Button>
        </>
      );
    }
    if (runnableStages.includes(stage)) {
      return (
        <Button
          variant="primary"
          iconLeft={<Icon name="play" size={13} />}
          onClick={runNow}
          disabled={!canRun}
          title={runDisabledReason || runCopy?.title}
        >
          {runStarting ? "Starting..." : runCopy?.label || "Run"}
        </Button>
      );
    }
    if (stage === "awaiting_children") {
      return (
        <Button
          variant="secondary"
          iconLeft={<Icon name="play" size={13} />}
          onClick={() => applyStatusTransition({ from: "awaiting_children", to: "execute" })}
          title="Move back to Execute without waiting for every delegated subtask."
        >
          Resume work
        </Button>
      );
    }
    if (stage === "awaiting_user") {
      return (
        <Button
          variant="secondary"
          iconLeft={<Icon name="play" size={13} />}
          onClick={() => applyStatusTransition({ from: "awaiting_user", to: interruptedStage })}
          title={`Move back to ${interruptedStage} after the requested input is handled.`}
        >
          Resume work
        </Button>
      );
    }
    if (stage === "blocked") {
      return (
        <Button
          variant="secondary"
          iconLeft={<Icon name="refresh-cw" size={13} />}
          onClick={() => applyStatusTransition({ from: "blocked", to: "execute" })}
          title="Clear the blocked state and move back to Execute."
        >
          Retry work
        </Button>
      );
    }
    if (stage === "done") {
      return (
        <Button variant="secondary" onClick={() => applyStatusTransition({ from: "done", to: "execute" })}>
          Reopen
        </Button>
      );
    }
    return null;
  }

  const taskActions = task && (
    <>
      {canEditTask && (
        <Button variant="ghost" iconLeft={<Icon name="settings" size={13} />} onClick={() => { navigateHash(`#/tasks/${currentTaskRouteId}/edit`); }}>
          Edit
        </Button>
      )}
      {canPreviewRunInput && (
        <Button variant="secondary" iconLeft={<Icon name="eye" size={13} />} onClick={openRunPreview}>
          Run input
        </Button>
      )}
      {renderPrimaryAction()}
    </>
  );
  const mobileActionDock = task && (
    <div class={`task-mobile-action-dock${stage === "review" && !runningRun ? " review-idle" : ""}`}>
      {canEditTask && (
        <Button variant="secondary" iconLeft={<Icon name="settings" size={13} />} onClick={() => { navigateHash(`#/tasks/${currentTaskRouteId}/edit`); }}>
          Edit
        </Button>
      )}
      {canPreviewRunInput && (
        <Button variant="secondary" iconLeft={<Icon name="eye" size={13} />} onClick={openRunPreview}>
          Run input
        </Button>
      )}
      {renderPrimaryAction()}
    </div>
  );
  const detailMeta = task && (
    <span class="task-hero-status-row">
      {canChangeTaskStatus ? (
        <StatusMenu status={statusMenuState} displayStage={stage} pulse={Boolean(runningRun)} onChoose={onStatusChoose} />
      ) : (
        <StatusPill status={statusMenuState} size="sm" />
      )}
      {task.project && (
        <EntityBadge kind="project" label={task.project.name || "Unknown"} href={`#/projects/${projectRouteId(task.project)}`} class="task-project-chip" title={`Project: ${task.project.name || "Unknown"}`} />
      )}
      {taskTeamRouteId && (
        <EntityBadge kind="team" label={taskTeamDisplay} href={`#/library/teams/${encodeURIComponent(taskTeamRouteId)}`} class="task-team-chip" title={`Team: ${taskTeamDisplay}`} />
      )}
      {task.is_team_root && (
        <EntityBadge kind="goal" label={taskGoalBadgeLabel} href={`#/goals/${encodeURIComponent(task.id)}`} title={taskGoalBadgeTitle} />
      )}
      {hasLastRunError && (
        <span class="chip chip-error">
          <Icon name="alert-triangle" size={10} /> Error
        </span>
      )}
      {recoveryLabel && (
        <span class="chip chip-warn">
          <Icon name="refresh-cw" size={10} /> {recoveryLabel}
        </span>
      )}
      {showStuckBanner && (
        <span class="chip chip-error">
          <Icon name="alert-triangle" size={10} /> Stuck - reset
        </span>
      )}
      {hasTaskSchedules && (
        <span
          class={`chip ${hasEnabledSchedule ? "chip-trigger" : "chip-muted"}`}
          title={automationSummary.next_fire_at ? `Next scheduled run: ${formatDate(automationSummary.next_fire_at)}` : undefined}
        >
          <Icon name={hasEnabledSchedule ? "clock" : "minus-circle"} size={10} />
          {hasEnabledSchedule ? "Scheduled" : "Schedule paused"}
        </span>
      )}
    </span>
  );
  const hasRailDependencies = ((task?.blocked_by || []).length > 0 || (task?.blocks || []).length > 0);
  const railCardCount = 3;
  const taskRail = task ? (
    <TaskRail
      task={task}
      agents={agents}
      hasRailDependencies={hasRailDependencies}
      runningRun={runningRun}
      runningRunStream={runningRunStream}
      onAssigneeChange={updateAssignee}
      onDelete={() => setDeleteOpen(true)}
      readOnly={isTeamRoot}
    />
  ) : null;
  const detailSubBar = task && (
    <MobilePillRow railLabel="Details" railCount={railCardCount} sections={TASK_DETAIL_SECTIONS} />
  );

  // §5.9 keyboard: ⌘Enter triggers primary, E opens edit
  useGlobalShortcuts({
    cmdenter: (e) => {
      e.preventDefault();
      const activeTag = document.activeElement?.tagName?.toLowerCase?.() || "";
      if ((activeTag === "textarea" || activeTag === "input") && newComment.trim()) {
        addComment();
        return;
      }
      if (runningRun) cancelRun();
      else if (showStuckBanner) retryStuck();
      else if (canRun) runNow();
      else if (stage === "awaiting_children" || stage === "blocked") {
        applyStatusTransition({ from: stage, to: "execute" });
      }
      else if (stage === "awaiting_user") {
        applyStatusTransition({ from: stage, to: interruptedStage });
      }
      else if (stage === "done") applyStatusTransition({ from: "done", to: "execute" });
    },
    "e": () => { if (canEditTask) navigateHash(`#/tasks/${currentTaskRouteId}/edit`); },
    "E": () => { if (canEditTask) navigateHash(`#/tasks/${currentTaskRouteId}/edit`); },
  });

  if (!data) {
    return (
      <AppShell route="tasks">
        <div class="page-wrap"><LoadingState caption="Loading task…" /></div>
      </AppShell>
    );
  }
  if (data.notFound) {
    return (
      <AppShell route="tasks">
        <div class="page-wrap">
            <EmptyState
              title="Task not found"
              body="This task may have been deleted."
              cta={<Button variant="primary" onClick={() => { navigateHash("#/tasks"); }}>Back to tasks</Button>}
            />
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell
      route="tasks"
      mobileActionDock={mobileActionDock}
      mobileTopbar={<MobileTopbar title={taskKeyLabel} backLabel="Tasks" onBack={() => navigateHash("#/tasks")} />}
      drawerTitle="Details"
      drawerKicker={taskKeyLabel}
      drawerContent={taskRail}
      sections={TASK_DETAIL_SECTIONS}
    >
      <div class="task-detail-shell editor-shell">
        <DetailHead
          class="task-detail-head"
          crumbs={[{ label: "Tasks", href: "#/tasks" }, { label: taskKeyLabel }]}
          kicker="Task detail"
          idPrefix={taskKeyLabel}
          title={task.title}
          titleClass="task-hero-title title-display"
          meta={detailMeta}
          actionsClass="task-hero-actions"
          actions={taskActions}
          subBar={detailSubBar}
          glyph="T"
        />
        <TaskParentReference task={task} />
        <div class="task-detail editor-body">
          <div class="task-detail-main editor-main">
            <FormSection class="task-brief-section" aria-labelledby="task-brief">
              <SectionMarker id="task-brief" num="01" kicker="Brief" meta="Request" />
              <div class={`task-hero-instructions${instructionsExpanded ? " expanded" : ""}${(task.instructions || "").length > 400 ? " clampable" : ""}`}>
                <InlineHead class="task-hero-instructions-head">
                  <div class="all-caps task-hero-instructions-kicker">
                    <Icon name="terminal" size={10} /> Instructions / Request
                  </div>
                  {task.instructions && (
                    <IconButton
                      class="task-hero-instructions-copy"
                      aria-label="Copy instructions"
                      icon={<Icon name="copy" size={12} />}
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(task.instructions || "");
                          pushToast("Copied", { variant: "success" });
                        } catch {
                          pushToast("Copy failed", { variant: "error" });
                        }
                      }}
                    />
                  )}
                </InlineHead>
                {task.instructions ? (
                  <pre class="task-hero-instructions-body">{task.instructions}</pre>
                ) : (
                  <div class="task-plan-empty">No instructions recorded.</div>
                )}
                {(task.instructions || "").length > 400 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    class="task-hero-instructions-toggle"
                    onClick={() => setInstructionsExpanded((v) => !v)}
                  >
                    {instructionsExpanded ? "Show less" : "Show full"}
                  </Button>
                )}
                {task.attachments?.length > 0 && (
                  <AttachmentChips attachments={task.attachments} disabled class="task-hero-attachments" />
                )}
              </div>
            </FormSection>

            <FormSection class="task-plan-section" aria-labelledby="task-plan">
              <SectionMarker id="task-plan" num="02" kicker="Plan" meta="Markdown" />
              <TaskPlanCard
                task={task}
                draft={planDraft}
                editing={!isTeamRoot && planEditing}
                saving={planSaving}
                mentions={resolvedMentions}
                onDraft={setPlanDraft}
                onEdit={() => setPlanEditing(true)}
                onCancel={cancelPlanEdit}
                onSave={savePlan}
                readOnly={isTeamRoot}
              />
            </FormSection>

            <FormSection class="task-workflow-section" aria-labelledby="task-workflow">
              <SectionMarker id="task-workflow" num="03" kicker="Workflow" meta="Hierarchy" />

              <TaskWorkflowMeta task={task} />

              <TaskPendingQuestionsCard
                task={task}
                onAnswered={handlePendingQuestionsAnswered}
              />

              <TaskSubtasksCard
                task={task}
              />

              <TaskAutomationsCard
                taskId={operationTaskId}
                automations={taskAutomations}
                loading={automationsLoading}
                onChanged={() => {
                  reload();
                  reloadAutomations();
                }}
              />

              {showStuckBanner && (
                <Banner
                  variant="warn"
                  title="This task shows as running but no worker is active."
                  detail={runError || undefined}
                  actions={
                    <>
                      <Button variant="secondary" size="sm" onClick={resetToExecute}>Reset</Button>
                      <Button variant="primary"  size="sm" onClick={retryStuck}>Retry</Button>
                    </>
                  }
                  dismissible={false}
                />
              )}

              {recoveryLabel && (
                <Banner
                  variant="warn"
                  title={recoveryLabel}
                  detail={recoveryDetail}
                  dismissible={false}
                />
              )}

              {runError && (
                <Banner variant="error" title="Run error" detail={runError} onDismiss={() => setRunError(null)} />
              )}

              {runningRun ? (
                <div ref={(node) => setRunTarget(runningRun.id, node)}>
                  <LiveRunPanel
                    run={runningRun}
                    isStreaming
                    agentLabel={agentDisplayName(agents, runningRun.agent_name, runningRun.agent_name)}
                    streamState={runningRunStream}
                  />
                </div>
              ) : null}
            </FormSection>

            <FormSection class="task-activity-section" aria-labelledby="task-activity">
              <SectionMarker id="task-activity" num="04" kicker="Activity" meta="Comments & runs" />
              <Card
                title="Activity"
                class="activity-card"
                headerRight={runsNextCursor ? (
                  <Button variant="ghost" size="sm" loading={runHistoryLoading} onClick={loadFullRunHistory}>
                    Load full history
                  </Button>
                ) : null}
              >
            <div class="activity-composer">
              <form onSubmit={addComment} class="activity-composer-form">
                <MentionableTextarea
                  rows={1}
                  autoGrow
                  class="activity-composer-input"
                  placeholder="Add a comment or instruction…"
                  value={newComment}
                  onInput={(e) => setNewComment(e.target.value)}
                  onPaste={handleCommentAttachmentPaste}
                  onDragOver={handleCommentAttachmentDragOver}
                  onDrop={handleCommentAttachmentDrop}
                  pathContext={{ taskId: task?.id, projectId: task?.project_id }}
                />
                <AttachmentChips
                  attachments={commentAttachments}
                  onChange={setCommentAttachments}
                  uploading={commentAttachmentUploading}
                  uploadError={commentAttachmentError}
                />
                <Toolbar class="activity-composer-actions">
                  <div class="activity-composer-options">
                    <Checkbox
                      class="activity-rerun-checkbox"
                      checked={commentRerun && !runningRun}
                      disabled={Boolean(runningRun)}
                      onChange={setCommentRerun}
                      label="Rerun task"
                    />
                    <span class="activity-composer-shortcut">Cmd Enter</span>
                  </div>
                  <Button type="submit" variant="primary" disabled={!newComment.trim() || commentSaving}>
                    {commentSaving ? "Posting…" : commentRerun && !runningRun ? "Post & run" : "Post"}
                  </Button>
                </Toolbar>
              </form>
            </div>

            {displayActivity.length > 0 ? (
              <div class="activity-feed">
                {displayActivity.map((item) => {
                  if (item.type === "run") {
                    const run = item.run;
                    return (
                      <div key={item.id} class="activity-feed-entry run" ref={(node) => setRunTarget(run.id, node)}>
                        <div class="activity-feed-rail">
                          <ActivityRailDot item={item} agentLabel={agentDisplayName(agents, run.agent_name, run.agent_name)} />
                        </div>
                        <div class="activity-feed-content">
                          <RunCard
                            run={run}
                            expanded={expandedRunIds.has(run.id)}
                            highlighted={highlightedRunId === run.id}
                            onToggle={toggleRun}
                            subscribe={(run.process_status || run.status) === "running"}
                            agents={agents}
                          />
                        </div>
                      </div>
                    );
                  }
                  const canDeleteComment = item.authorType === "human" && item.commentId;
                  return (
                    <div key={item.id} class={`activity-feed-entry comment ${item.authorType || "human"}`}>
                      <div class="activity-feed-rail"><ActivityRailDot item={item} /></div>
                      <div class="activity-feed-content activity-item">
                        <InlineHead class="activity-item-head">
                          {renderCommentAuthor(item)}
                          <span class="activity-item-time" title={formatDate(item.at) || undefined}>{formatActivityTime(item.at)}</span>
                          {canDeleteComment && (
                            <IconButton
                              class="activity-comment-delete"
                              size="sm"
                              variant="ghost"
                              icon={<Icon name="trash" size={13} />}
                              aria-label="Delete comment"
                              title="Delete comment"
                              onClick={() => setCommentDeleteTarget(item)}
                            />
                          )}
                        </InlineHead>
                        {item.body && (
                          <div class="activity-item-body"><StructuredContent content={item.body} maxHeight={200} mentions={resolvedMentions} /></div>
                        )}
                        {item.attachments?.length > 0 && (
                          <AttachmentChips attachments={item.attachments} disabled class="activity-item-attachments" />
                        )}
                      </div>
                    </div>
                  );
                })}
                {!showOlderActivity && activity.length > 12 && (
                  <Button variant="ghost" size="sm" onClick={() => setShowOlderActivity(true)}>
                    Show older ({activity.length - 12})
                  </Button>
                )}
              </div>
            ) : (
              <div class="activity-empty">{runningRun ? "No comments or completed runs yet." : "No activity yet."}</div>
            )}
              </Card>
            </FormSection>
          </div>

          <aside class="task-detail-rail editor-rail">
            {taskRail}
          </aside>
        </div>
      </div>

      <TaskDetailModals
        statusModal={statusModal}
        setStatusModal={setStatusModal}
        applyStatusTransition={applyStatusTransition}
        deleteOpen={deleteOpen}
        setDeleteOpen={setDeleteOpen}
        destroy={destroy}
        commentDeleteTarget={commentDeleteTarget}
        commentDeleting={commentDeleting}
        setCommentDeleteTarget={setCommentDeleteTarget}
        deleteComment={deleteComment}
      />

      <RunInputPreviewModal
        open={runPreviewOpen}
        onClose={() => setRunPreviewOpen(false)}
        preview={runPreview}
        loading={runPreviewLoading}
        error={runPreviewError}
        onCopy={copyRunPreview}
      />
    </AppShell>
  );
}
