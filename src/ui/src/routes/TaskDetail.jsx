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
import { onPageVisible, pageIsVisible } from "../lib/pageVisibility.js";
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
import { LiveRunPanel } from "../components/LiveRunPanel.jsx";
import { StatusMenu } from "../components/StatusMenu.jsx";
import { Modal } from "../components/Modal.jsx";
import { Textarea } from "../components/primitives/Textarea.jsx";
import { Checkbox } from "../components/primitives/Checkbox.jsx";
import { DetailHead, SectionMarker } from "../components/layout/index.js";
import { StructuredContent } from "../components/StructuredContent.jsx";
import { navigateHash } from "../lib/navigation.js";
import { ActivityRailDot, buildActivity, commentAuthorLabel } from "./task-detail/activity.jsx";
import {
  DEFAULT_RUN_POLICY,
  TASK_DETAIL_SECTIONS,
  formatActivityTime,
  formatDate,
  projectRouteId,
} from "./task-detail/format.js";
import { RunCard, RunArtifactsSection } from "./task-detail/RunCards.jsx";
import { RunInputPreviewModal } from "./task-detail/RunInputPreviewModal.jsx";
import { formatRunPreviewForCopy } from "./task-detail/runPreview.js";
import {
  AgentRailRow,
  TaskAutomationsCard,
  TaskContextList,
  TaskPlanCard,
  TaskSubtasksCard,
  TaskWorkflowMeta,
} from "./task-detail/WorkflowCards.jsx";

function dependencyContextLabel(dependency) {
  const latest = dependency?.latest_execute_run;
  const artifacts = dependency?.artifact_summary || {};
  const parts = [];
  if (latest?.summary) {
    parts.push(latest.summary);
  } else if (latest?.id) {
    parts.push(`Latest execute ${latest.status || latest.process_status || "recorded"}`);
  } else if ((dependency?.stage || "plan") === "done") {
    parts.push("No execute run recorded");
  }
  const files = Number(artifacts.files || 0);
  if (files > 0) {
    const added = Number(artifacts.added_lines || 0);
    const removed = Number(artifacts.removed_lines || 0);
    const delta = added || removed ? `, +${added} -${removed}` : "";
    parts.push(`${files} file${files === 1 ? "" : "s"}${delta}`);
  }
  return parts.join(" - ");
}

function DependencyLink({ dependency }) {
  const context = dependencyContextLabel(dependency);
  return (
    <a key={dependency.id} class="blocked-link dependency-link" href={`#/tasks/${taskRouteId(dependency)}`}>
      <span class="dependency-link-copy">
        <span class="truncate">{dependency.title}</span>
        {context && <span class="dependency-link-meta">{context}</span>}
      </span>
      <StatusPill status={dependency.stage || "plan"} size="sm" />
    </a>
  );
}

const TASK_DETAIL_CACHE_LIMIT = 16;
const taskDetailCache = new Map();

function taskDetailCacheKeys(task) {
  return [
    task?.id,
    task?.task_key,
  ].filter(Boolean).map(String);
}

function cloneTaskDetailData(data) {
  if (!data?.task) return null;
  return {
    ...data,
    task: { ...data.task },
    comments: [...(data.comments || [])],
    runs: [...(data.runs || [])],
  };
}

function defaultAutomationSummary() {
  return {
    count: 0,
    enabled_count: 0,
    paused_count: 0,
    next_fire_at: null,
    last_trigger: null,
  };
}

export function taskDetailDataFromTaskSummary(task) {
  if (!task) return null;
  const runningRun = task.running_run || (task.running_run_id ? {
    id: task.running_run_id,
    status: "running",
    process_status: "running",
    started_at: task.running_run_started_at || null,
    agent_name: task.owner_agent || null,
  } : null);
  return {
    task: {
      ...task,
      tags: Array.isArray(task.tags) ? task.tags : [],
      dependency_ids: Array.isArray(task.dependency_ids) ? task.dependency_ids : [],
      blocked_by: Array.isArray(task.blocked_by) ? task.blocked_by : [],
      blocks: Array.isArray(task.blocks) ? task.blocks : [],
      children: Array.isArray(task.children) ? task.children : [],
      automations: Array.isArray(task.automations) ? task.automations : [],
      automation_summary: task.automation_summary || defaultAutomationSummary(),
      artifacts: Array.isArray(task.artifacts) ? task.artifacts : [],
      artifact_summary: task.artifact_summary || {},
      plan_body: task.plan_body || "",
      stage: task.stage || "plan",
    },
    comments: [],
    runs: runningRun ? [runningRun] : [],
  };
}

export function writeTaskDetailCache(data) {
  const snapshot = cloneTaskDetailData(data);
  if (!snapshot?.task) return;
  for (const key of taskDetailCacheKeys(snapshot.task)) {
    if (taskDetailCache.has(key)) taskDetailCache.delete(key);
    taskDetailCache.set(key, snapshot);
  }
  while (taskDetailCache.size > TASK_DETAIL_CACHE_LIMIT) {
    taskDetailCache.delete(taskDetailCache.keys().next().value);
  }
}

export function writeTaskDetailSummaryCache(task) {
  const data = taskDetailDataFromTaskSummary(task);
  if (data) writeTaskDetailCache(data);
}

export function readTaskDetailCache(id) {
  const snapshot = taskDetailCache.get(String(id || ""));
  return cloneTaskDetailData(snapshot);
}

export function clearTaskDetailCache() {
  taskDetailCache.clear();
}

export function TaskDetail({ id, runParam = null }) {
  const [data, setData] = useState(() => readTaskDetailCache(id));
  const [agents, setAgents] = useState([]);
  const [newComment, setNewComment] = useState("");
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

  const reload = useCallback(() => {
    reloadAbortRef.current?.abort?.();
    const controller = new AbortController();
    reloadAbortRef.current = controller;
    return api.getTask(id, { signal: controller.signal })
      .then((nextData) => {
        if (controller.signal.aborted) return;
        writeTaskDetailCache(nextData);
        setData(nextData);
      })
      .catch((err) => {
        if (err?.name === "AbortError") return;
        const cached = readTaskDetailCache(id);
        setData(cached || { notFound: true });
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
  const flushHiddenReloads = useCallback(() => {
    if (!pageIsVisible()) return;
    if (hiddenDetailReloadRef.current) {
      hiddenDetailReloadRef.current = false;
      reloadSoon();
    }
    if (hiddenAutomationsReloadRef.current) {
      hiddenAutomationsReloadRef.current = false;
      reloadAutomationsSoon();
    }
  }, [reloadAutomationsSoon, reloadSoon]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { reloadAutomations(); }, [reloadAutomations]);
  useEffect(() => {
    const controller = new AbortController();
    api.listAgents({ signal: controller.signal }).then((r) => setAgents(r.agents || [])).catch((err) => {
      if (err?.name !== "AbortError") setAgents([]);
    });
    return () => controller.abort();
  }, []);
  useEffect(() => () => {
    reloadAbortRef.current?.abort?.();
    automationsAbortRef.current?.abort?.();
  }, []);
  useEffect(() => onPageVisible(flushHiddenReloads), [flushHiddenReloads]);
  useEffect(() => {
    const cached = readTaskDetailCache(id);
    if (cached) setData(cached);
    setHighlightedRunId(runParam || null);
    setExpandedRunIds(new Set());
    setRunError(null);
    setRunStarting(false);
    setPlanEditing(false);
    setPlanDraft("");
    setTaskAutomations(null);
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
  const runs = data?.runs || [];
  const comments = data?.comments || [];
  const stage = task?.stage || "plan";
  const automationSummary = task?.automation_summary || {};
  const hasTaskSchedules = Number(automationSummary.count || 0) > 0;
  const hasEnabledSchedule = Number(automationSummary.enabled_count || 0) > 0;
  const runningRun = runs.find((r) => (r.process_status || r.status) === "running") || null;
  const displayedStage = runningRun ? "running" : stage;
  const lastFinishedRun = runs.find((r) => (r.process_status || r.status) && (r.process_status || r.status) !== "running") || null;
  const lastRunState = lastFinishedRun?.process_status || lastFinishedRun?.status;
  const hasLastRunError = !runningRun && (lastRunState === "failed" || lastRunState === "error" || lastRunState === "abandoned");
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
    initialEventLimit: 24,
    maxEvents: 80,
  });

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
      const result = await api.addComment(operationTaskId, newComment.trim(), { rerun: shouldRerun });
      setNewComment("");
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
  const runCopy = {
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
  const canPreviewRunInput = task && runnableStages.includes(stage) && !runningRun;
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
          onClick={() => applyStatusTransition({ from: "awaiting_user", to: "execute" })}
          title="Move back to Execute after the requested input is handled."
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
      <Button variant="ghost" iconLeft={<Icon name="settings" size={13} />} onClick={() => { navigateHash(`#/tasks/${currentTaskRouteId}/edit`); }}>
        Edit
      </Button>
      {canPreviewRunInput && (
        <Button variant="secondary" iconLeft={<Icon name="eye" size={13} />} onClick={openRunPreview}>
          Run input
        </Button>
      )}
      {renderPrimaryAction()}
    </>
  );
  const mobileActionDock = task && (
    <>
      <Button variant="secondary" iconLeft={<Icon name="settings" size={13} />} onClick={() => { navigateHash(`#/tasks/${currentTaskRouteId}/edit`); }}>
        Edit
      </Button>
      {canPreviewRunInput && (
        <Button variant="secondary" iconLeft={<Icon name="eye" size={13} />} onClick={openRunPreview}>
          Run input
        </Button>
      )}
      {renderPrimaryAction()}
    </>
  );
  const detailMeta = task && (
    <span class="task-hero-status-row">
      <StatusMenu status={displayedStage} onChoose={onStatusChoose} />
      {task.project && (
        <a class="chip chip-muted task-project-chip" href={`#/projects/${projectRouteId(task.project)}`} title={`Project: ${task.project.name || task.project.slug}`}>
          <Icon name="folder" size={10} /> {task.project.name || task.project.slug}
        </a>
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
  const detailSubBar = task && (
    <MobilePillRow railLabel="Details" railCount={railCardCount} sections={TASK_DETAIL_SECTIONS} />
  );

  function renderTaskRail() {
    if (!task) return null;
    return (
      <div class="task-detail-rail-content">
        <Card variant="spacious" kicker="Assignment" title="Roles" class="rail-agents-card">
          <div class="rail-agents-stack">
            <AgentRailRow
              role="owner"
              value={task.owner_agent || ""}
              onChange={(value) => updateAssignee("owner_agent", value)}
              agents={agents}
              caption={task.owner_agent ? "Runs work" : undefined}
            />
            <AgentRailRow
              role="planner"
              value={task.planner_agent || ""}
              onChange={(value) => updateAssignee("planner_agent", value)}
              agents={agents}
            />
            <AgentRailRow
              role="reviewer"
              value={task.reviewer_agent || ""}
              onChange={(value) => updateAssignee("reviewer_agent", value)}
              agents={agents}
            />
          </div>
        </Card>

        <Card variant="spacious" kicker="Context" title="Metadata" class="task-metadata-card task-context-card">
          <TaskContextList task={task} />
          {hasRailDependencies && (
            <div class="task-dependencies-section">
              <div class="task-rail-section-head">
                <span class="all-caps">Dependencies</span>
              </div>
              {(task.blocked_by || []).length > 0 && (
                <div class="dependency-group">
                  <div class="all-caps">Blocked by</div>
                  {(task.blocked_by || []).map((dependency) => (
                    <DependencyLink key={dependency.id} dependency={dependency} />
                  ))}
                </div>
              )}
              {(task.blocks || []).length > 0 && (
                <div class={`dependency-group ${(task.blocked_by || []).length > 0 ? "dependency-group-spaced" : ""}`}>
                  <div class="all-caps">Blocks</div>
                  {(task.blocks || []).map((dependency) => (
                    <DependencyLink key={dependency.id} dependency={dependency} />
                  ))}
                </div>
              )}
            </div>
          )}
          <RunArtifactsSection task={task} runningRun={runningRun} streamState={runningRunStream} />
        </Card>

        <Card variant="spacious" kicker="Actions" title="Maintenance" class="task-maintenance-card">
          <div class="task-actions-stack">
            <Button
              variant="secondary"
              iconLeft={<Icon name="database" size={13} />}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(taskDisplayKey(task));
                  pushToast("Task key copied", { variant: "success" });
                } catch {
                  pushToast("Copy failed", { variant: "error" });
                }
              }}
            >
              Copy task key
            </Button>
            <Button
              variant="secondary"
              iconLeft={<Icon name="copy" size={13} />}
              onClick={async () => {
                try {
                  const copy = {
                    title: `Copy of ${task.title}`,
                    instructions: task.instructions,
                    owner_agent: task.owner_agent,
                    planner_agent: task.planner_agent,
                    reviewer_agent: task.reviewer_agent,
                    run_policy: task.run_policy || DEFAULT_RUN_POLICY,
                    project_id: task.project_id || null,
                    tags: task.tags,
                  };
                  const r = await api.createTask(copy);
                  pushToast("Task duplicated", { variant: "success" });
                  navigateHash(`#/tasks/${taskRouteId(r.task)}`);
                } catch (err) { pushToast(`Duplicate failed: ${err.message}`, { variant: "error" }); }
              }}
            >Duplicate</Button>
            <Button
              variant="destructive"
              iconLeft={<Icon name="trash" size={13} />}
              onClick={() => setDeleteOpen(true)}
            >
              Delete task
            </Button>
          </div>
        </Card>
      </div>
    );
  }

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
      else if (stage === "awaiting_children" || stage === "awaiting_user" || stage === "blocked") {
        applyStatusTransition({ from: stage, to: "execute" });
      }
      else if (stage === "done") applyStatusTransition({ from: "done", to: "execute" });
    },
    "e": () => { navigateHash(`#/tasks/${currentTaskRouteId}/edit`); },
    "E": () => { navigateHash(`#/tasks/${currentTaskRouteId}/edit`); },
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
      drawerContent={renderTaskRail()}
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
          actions={taskActions && <div class="task-hero-actions toolbar">{taskActions}</div>}
          subBar={detailSubBar}
          glyph="T"
        />
        <div class="task-detail editor-body">
          <div class="task-detail-main editor-main">
            <section class="task-brief-section" aria-labelledby="task-brief">
              <SectionMarker id="task-brief" num="01" kicker="Brief" meta="Request" />
              <div class={`task-hero-instructions${instructionsExpanded ? " expanded" : ""}${(task.instructions || "").length > 400 ? " clampable" : ""}`}>
                <div class="task-hero-instructions-head">
                  <div class="all-caps task-hero-instructions-kicker">
                    <Icon name="terminal" size={10} /> Instructions / Request
                  </div>
                  {task.instructions && (
                    <button
                      type="button"
                      class="task-hero-instructions-copy"
                      aria-label="Copy instructions"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(task.instructions || "");
                          pushToast("Copied", { variant: "success" });
                        } catch {
                          pushToast("Copy failed", { variant: "error" });
                        }
                      }}
                    >
                      <Icon name="copy" size={12} />
                    </button>
                  )}
                </div>
                {task.instructions ? (
                  <pre class="task-hero-instructions-body">{task.instructions}</pre>
                ) : (
                  <div class="task-plan-empty">No instructions recorded.</div>
                )}
                {(task.instructions || "").length > 400 && (
                  <button
                    type="button"
                    class="task-hero-instructions-toggle"
                    onClick={() => setInstructionsExpanded((v) => !v)}
                  >
                    {instructionsExpanded ? "Show less" : "Show full"}
                  </button>
                )}
              </div>
            </section>

            <section class="task-plan-section" aria-labelledby="task-plan">
              <SectionMarker id="task-plan" num="02" kicker="Plan" meta="Markdown" />
              <TaskPlanCard
                task={task}
                draft={planDraft}
                editing={planEditing}
                saving={planSaving}
                onDraft={setPlanDraft}
                onEdit={() => setPlanEditing(true)}
                onCancel={cancelPlanEdit}
                onSave={savePlan}
              />
            </section>

            <section class="task-workflow-section" aria-labelledby="task-workflow">
              <SectionMarker id="task-workflow" num="03" kicker="Workflow" meta="Hierarchy" />

              <TaskWorkflowMeta task={task} />

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
            </section>

            <section class="task-activity-section" aria-labelledby="task-activity">
              <SectionMarker id="task-activity" num="04" kicker="Activity" meta="Comments & runs" />
              <Card
                title="Activity"
                class="activity-card"
              >
            <div class="activity-composer">
              <form onSubmit={addComment} class="activity-composer-form">
                <Textarea
                  rows={1}
                  autoGrow
                  class="activity-composer-input"
                  placeholder="Add a comment or instruction…"
                  value={newComment}
                  onInput={(e) => setNewComment(e.target.value)}
                />
                <div class="activity-composer-actions">
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
                </div>
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
                        <div class="activity-item-head">
                          <span class={`activity-author-badge ${item.authorType || "human"}`}>{commentAuthorLabel(item)}</span>
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
                        </div>
                        {item.body && (
                          <div class="activity-item-body"><StructuredContent content={item.body} maxHeight={200} /></div>
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
            </section>
          </div>

          <aside class="task-detail-rail editor-rail">
            {renderTaskRail()}
          </aside>
        </div>
      </div>

      {/* Stage-transition confirm modal */}
      <Modal
        open={!!statusModal}
        onClose={() => setStatusModal(null)}
        title="Confirm stage change"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setStatusModal(null)}>Cancel</Button>
            <Button variant="primary" onClick={() => {
              const t = statusModal;
              setStatusModal(null);
              applyStatusTransition(t);
            }}>Confirm</Button>
          </>
        }
      >
        <p>{statusModal?.confirm || ""}</p>
      </Modal>

      {/* Delete task modal */}
      <Modal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="Delete task?"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={() => { setDeleteOpen(false); destroy(); }}>Delete</Button>
          </>
        }
      >
        <p>This permanently removes the task and its runs. This action cannot be undone.</p>
      </Modal>

      <Modal
        open={!!commentDeleteTarget}
        onClose={() => !commentDeleting && setCommentDeleteTarget(null)}
        title="Delete comment?"
        size="sm"
        footer={
          <>
            <Button variant="ghost" disabled={commentDeleting} onClick={() => setCommentDeleteTarget(null)}>Cancel</Button>
            <Button variant="destructive" loading={commentDeleting} onClick={deleteComment}>Delete</Button>
          </>
        }
      >
        <p>This permanently removes this human comment from the task and future run prompts.</p>
      </Modal>

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
