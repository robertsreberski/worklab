import { useState } from "preact/hooks";

import { AgentPicker } from "../../components/AgentPicker.jsx";
import { Card } from "../../components/Card.jsx";
import { FormSection } from "../../components/FormSection.jsx";
import { Icon } from "../../components/Icon.jsx";
import { MarkdownContent } from "../../components/Markdown.jsx";
import { Button } from "../../components/primitives/Button.jsx";
import { Checkbox } from "../../components/primitives/Checkbox.jsx";
import { Chip } from "../../components/primitives/Chip.jsx";
import { RadioGroup } from "../../components/primitives/RadioGroup.jsx";
import { ScheduleBuilder, normalizeScheduleTrigger as normalizeAutomationTrigger } from "../../components/primitives/ScheduleBuilder.jsx";
import { StatusPill } from "../../components/primitives/StatusPill.jsx";
import { Textarea } from "../../components/primitives/Textarea.jsx";
import { MentionableTextarea } from "../../components/MentionableTextarea.jsx";
import { InlineHead, SectionStack, Toolbar } from "../../components/layout/index.js";
import { api } from "../../lib/api.js";
import { collapseDuplicateParagraphs } from "../../lib/commentFormatting.js";
import { taskDisplayKey, taskRouteId } from "../../lib/display.js";
import { pushToast } from "../../lib/toast.js";
import {
  formatDate,
  formatMetadataAge,
  formatMetadataDateWithAge,
  formatRunPolicy,
  projectRouteId,
} from "./format.js";

function emptyAutomationDraft() {
  return {
    enabled: true,
    trigger: normalizeAutomationTrigger({ type: "daily", hour: 9, minute: 0 }),
  };
}

function automationDraftFrom(automation) {
  return {
    enabled: automation.enabled !== false,
    trigger: normalizeAutomationTrigger(automation.trigger),
  };
}

export function TaskContextList({ task }) {
  const items = [
    task.project ? {
      label: "Project",
      value: (
        <a href={`#/projects/${projectRouteId(task.project)}`} class="task-meta-project-link">
          <Icon name="folder" size={12} />
          <span>{task.project.name || task.project.slug}</span>
        </a>
      ),
      mono: false,
    } : null,
    task.effective_workdir ? { label: "Workdir", value: task.effective_workdir, mono: true } : null,
    task.updated_at ? { label: "Updated", value: formatMetadataAge(task.updated_at) } : null,
    task.created_at ? { label: "Created", value: formatMetadataDateWithAge(task.created_at) } : null,
    task.completed_at ? { label: "Completed", value: formatMetadataDateWithAge(task.completed_at) } : null,
    task.automation_summary?.next_fire_at ? { label: "Next scheduled run", value: formatMetadataDateWithAge(task.automation_summary.next_fire_at) } : null,
    { label: "Run mode", value: formatRunPolicy(task.run_policy), mono: false },
    (task.tags || []).length ? {
      label: "Tags",
      value: (
        <span class="task-meta-tags">
          {(task.tags || []).map((tag) => <Chip key={tag} variant="tag">{tag}</Chip>)}
        </span>
      ),
      mono: false,
    } : null,
  ].filter(Boolean);

  if (items.length === 0) return null;

  return (
    <dl class="task-meta-list">
      {items.flatMap((item) => [
        <dt key={`${item.label}-label`}>{item.label}</dt>,
        <dd key={`${item.label}-value`} class={item.mono ? "mono" : ""}>{item.value}</dd>,
      ])}
    </dl>
  );
}

export function TaskParentReference({ task }) {
  const parent = task?.parent;
  if (!parent || !parent.id || parent.id === task.id) return null;
  const parentKey = taskDisplayKey(parent);
  return (
    <a
      href={`#/tasks/${taskRouteId(parent)}`}
      class="task-parent-reference"
      title={`Parent: ${parentKey} - ${parent.title}`}
      aria-label={`Open parent task ${parentKey}: ${parent.title}`}
    >
      <span class="task-parent-reference-glyph">
        <Icon name="corner-up-left" size={14} class="task-parent-reference-icon" />
      </span>
      <span class="task-parent-reference-copy">
        <span class="task-parent-reference-meta">
          <span class="task-parent-reference-label">Parent task</span>
          <span class="task-parent-reference-key pane-row-mono">{parentKey}</span>
          <StatusPill status={parent.stage || "plan"} size="sm" class="task-parent-reference-status" />
        </span>
        <span class="task-parent-reference-title">{parent.title}</span>
      </span>
      <Icon name="chevron-right" size={14} class="task-parent-reference-arrow" />
    </a>
  );
}

export function TaskWorkflowMeta({ task }) {
  if (!task) return null;
  const stageReason = task.stage_reason;
  const pendingActions = Array.isArray(task.pending_actions) ? task.pending_actions : [];
  const pendingQuestions = Array.isArray(task.pending_questions) ? task.pending_questions : [];
  const blockingIssues = Array.isArray(task.blocking_issues) ? task.blocking_issues : [];
  const showPendingActions = task.stage === "awaiting_user" && pendingActions.length > 0 && pendingQuestions.length === 0;
  const showStageReason = stageReason && task.stage !== "execute" && task.stage !== "done";
  if (!showStageReason && !showPendingActions && blockingIssues.length === 0) {
    return null;
  }
  return (
    <FormSection class="task-workflow-meta">
      {showStageReason && (
        <div class="task-workflow-stage-reason">
          <Icon name="info" size={12} />
          <span>{stageReason}</span>
        </div>
      )}
      {showPendingActions && (
        <Card title="Human actions needed" class="task-workflow-pending">
          <ul class="task-workflow-list">
            {pendingActions.map((action, idx) => <li key={idx}>{action}</li>)}
          </ul>
        </Card>
      )}
      {blockingIssues.length > 0 && (
        <Card title="Blocking issues" class="task-workflow-blocking">
          <ul class="task-workflow-list">
            {blockingIssues.map((issue, idx) => <li key={idx}>{issue}</li>)}
          </ul>
        </Card>
      )}
    </FormSection>
  );
}

export function shouldRenderTaskPendingQuestionsCard(task) {
  return task?.stage === "awaiting_user"
    && Array.isArray(task.pending_questions)
    && task.pending_questions.length > 0;
}

export function isPendingQuestionAnswered(question, answer = {}) {
  const selected = Array.isArray(answer.selected) ? answer.selected.filter(Boolean) : [];
  const text = typeof answer.text === "string" ? answer.text.trim() : "";
  return selected.length > 0 || (question?.allow_free_text === true && text.length > 0);
}

function emptyQuestionAnswer() {
  return { selected: [], text: "" };
}

function optionLabel(option) {
  return option?.label || "";
}

function optionDescription(option) {
  return option?.description || "";
}

export function TaskPendingQuestionsCard({ task, onAnswered }) {
  const questions = Array.isArray(task?.pending_questions) ? task.pending_questions : [];
  const [answers, setAnswers] = useState({});
  const [saving, setSaving] = useState(false);
  if (!shouldRenderTaskPendingQuestionsCard(task)) return null;

  function patchAnswer(questionId, patch) {
    setAnswers((current) => ({
      ...current,
      [questionId]: { ...emptyQuestionAnswer(), ...(current[questionId] || {}), ...patch },
    }));
  }

  function toggleOption(question, optionId, checked) {
    const current = answers[question.id] || emptyQuestionAnswer();
    if (!question.multi_select) {
      patchAnswer(question.id, { selected: [optionId] });
      return;
    }
    const selected = new Set(current.selected || []);
    if (checked) selected.add(optionId);
    else selected.delete(optionId);
    patchAnswer(question.id, { selected: [...selected] });
  }

  const complete = questions.every((question) => isPendingQuestionAnswered(question, answers[question.id]));

  async function submitAnswers(event) {
    event?.preventDefault?.();
    if (!complete || saving) return;
    setSaving(true);
    try {
      const result = await api.answerPendingQuestions(task.id, answers);
      if (result?.rerun?.started) {
        pushToast("Answers submitted and plan resumed", { variant: "success" });
      } else if (result?.rerun?.error) {
        pushToast(`Answers submitted; plan did not start: ${result.rerun.error.message}`, { variant: "error" });
      } else {
        pushToast("Answers submitted", { variant: "success" });
      }
      onAnswered?.(result);
    } catch (error) {
      pushToast(`Could not submit answers: ${error.message}`, { variant: "error" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card title="Planning questions" class="task-pending-questions-card">
      <form class="task-pending-questions-form" onSubmit={submitAnswers}>
        {questions.map((question, index) => {
          const answer = answers[question.id] || emptyQuestionAnswer();
          const selected = new Set(answer.selected || []);
          return (
            <fieldset class="task-pending-question" key={question.id || index}>
              <legend>{question.header || `Question ${index + 1}`}</legend>
              <div class="task-pending-question-text">{question.question}</div>
              <div class="task-pending-options">
                {question.multi_select ? (
                  (question.options || []).map((option) => {
                    const checked = selected.has(option.id);
                    const description = optionDescription(option);
                    return (
                      <Checkbox
                        key={option.id}
                        checked={checked}
                        onChange={(value) => toggleOption(question, option.id, value)}
                        label={description ? `${optionLabel(option)} - ${description}` : optionLabel(option)}
                        disabled={saving}
                      />
                    );
                  })
                ) : (
                  <RadioGroup
                    value={[...selected][0] || ""}
                    onChange={(value) => toggleOption(question, value, true)}
                    options={(question.options || []).map((option) => ({
                      value: option.id,
                      label: optionLabel(option),
                      description: optionDescription(option),
                      disabled: saving,
                    }))}
                    ariaLabel={question.header || `Question ${index + 1}`}
                    variant="stacked"
                    class="task-pending-radio-group"
                  />
                )}
              </div>
              {question.allow_free_text && (
                <MentionableTextarea
                  rows={2}
                  autoGrow
                  class="task-pending-free-text"
                  placeholder="Additional answer..."
                  value={answer.text || ""}
                  disabled={saving}
                  onInput={(event) => patchAnswer(question.id, { text: event.currentTarget.value })}
                />
              )}
            </fieldset>
          );
        })}
        <Toolbar class="task-pending-question-actions">
          <Button type="submit" variant="primary" disabled={!complete || saving}>
            {saving ? "Submitting..." : "Submit answers"}
          </Button>
        </Toolbar>
      </form>
    </Card>
  );
}

export function TaskPlanCard({
  task,
  draft,
  editing,
  saving,
  onDraft,
  onEdit,
  onCancel,
  onSave,
}) {
  const planBody = task?.plan_body || "";
  const displayPlanBody = collapseDuplicateParagraphs(planBody);
  const hasPlan = planBody.trim().length > 0;
  const meta = [
    task?.plan_updated_at ? `Updated ${formatDate(task.plan_updated_at)}` : null,
    task?.plan_updated_by ? `by ${task.plan_updated_by}` : null,
    task?.plan_source_run_id ? `from run ${String(task.plan_source_run_id).slice(-6)}` : null,
  ].filter(Boolean).join(" ");

  return (
    <Card
      title="Plan"
      class="task-plan-card"
      headerRight={
        editing ? (
          <>
            <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>Cancel</Button>
            <Button variant="primary" size="sm" onClick={onSave} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </>
        ) : (
          <Button variant="secondary" size="sm" iconLeft={<Icon name={hasPlan ? "edit-3" : "plus"} size={13} />} onClick={onEdit}>
            {hasPlan ? "Edit" : "Write"}
          </Button>
        )
      }
    >
      {meta && <div class="task-plan-meta">{meta}</div>}
      {editing ? (
        <MentionableTextarea
          rows={8}
          autoGrow
          class="task-plan-editor"
          placeholder="Write the task plan…"
          value={draft}
          onInput={(event) => onDraft(event.currentTarget.value)}
        />
      ) : hasPlan ? (
        <div class="task-plan-body">
          <MarkdownContent content={displayPlanBody} maxHeight={360} />
        </div>
      ) : (
        <div class="task-plan-empty">No plan yet. Run plan or write one.</div>
      )}
    </Card>
  );
}

export function shouldRenderTaskSubtasksCard(task) {
  return Array.isArray(task?.children) && task.children.length > 0;
}

export function TaskSubtasksCard({ task }) {
  const children = Array.isArray(task?.children) ? task.children : [];
  if (!shouldRenderTaskSubtasksCard(task)) return null;

  return (
    <Card title={`Child tasks (${children.length})`} class="task-subtasks-card">
      <ul class="task-subtasks-list">
        {children.map((child) => {
          const lastRun = child.last_run || child.latest_run || null;
          const runSummary = lastRun?.summary || lastRun?.details || "";
          return (
            <li key={child.id}>
              <a href={`#/tasks/${taskRouteId(child)}`} class="task-subtask-link">
                <span class="task-subtask-main min-w-0">
                  <span class="task-subtask-title truncate">
                    <span class="pane-row-mono">{taskDisplayKey(child)}</span>
                    <span>{child.title}</span>
                  </span>
                  {runSummary && <span class="task-subtask-summary truncate">{runSummary}</span>}
                </span>
                <span class="task-subtask-meta">
                  {child.owner_agent && (
                    <Chip variant="muted" size="sm">
                      {child.owner_agent}
                    </Chip>
                  )}
                  <Chip variant={child.required === false ? "muted" : "tag"} size="sm">
                    {child.required === false ? "optional" : "required"}
                  </Chip>
                  {lastRun?.decision && (
                    <Chip variant={lastRun.failure_kind ? "warn" : "tag"} size="sm">
                      {lastRun.failure_kind || lastRun.decision}
                    </Chip>
                  )}
                  <StatusPill status={child.stage || "plan"} size="sm" />
                </span>
              </a>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function automationOutcomeMeta(automation) {
  const latest = automation.recent_triggers?.[0] || null;
  if (!automation.enabled) return { label: "Paused", className: "chip-muted", icon: "minus-circle" };
  if (latest?.outcome === "skipped") return { label: "Skipped", className: "chip-warn", icon: "alert-circle" };
  if (latest?.outcome === "failed") return { label: "Failed", className: "chip-error", icon: "alert-triangle" };
  return { label: "Enabled", className: "chip-trigger", icon: "clock" };
}

export function TaskAutomationsCard({ taskId, automations, loading, onChanged }) {
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState(emptyAutomationDraft);
  const [saving, setSaving] = useState(false);

  function startNew() {
    setEditingId("new");
    setDraft(emptyAutomationDraft());
  }

  function startEdit(automation) {
    setEditingId(automation.id);
    setDraft(automationDraftFrom(automation));
  }

  function cancelEdit() {
    setEditingId(null);
    setDraft(emptyAutomationDraft());
  }

  function patchDraft(patch) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  async function saveAutomation(event) {
    event?.preventDefault?.();
    setSaving(true);
    try {
      const payload = {
        enabled: !!draft.enabled,
        trigger: normalizeAutomationTrigger(draft.trigger),
      };
      if (editingId === "new") {
        await api.createTaskAutomation(taskId, payload);
        pushToast("Schedule created", { variant: "success" });
      } else {
        await api.patchTaskAutomation(taskId, editingId, payload);
        pushToast("Schedule saved", { variant: "success" });
      }
      cancelEdit();
      onChanged?.();
    } catch (error) {
      pushToast(`Schedule save failed: ${error.message}`, { variant: "error" });
    } finally {
      setSaving(false);
    }
  }

  async function deleteAutomation(automation) {
    try {
      await api.deleteTaskAutomation(taskId, automation.id);
      pushToast("Schedule deleted", { variant: "success" });
      if (editingId === automation.id) cancelEdit();
      onChanged?.();
    } catch (error) {
      pushToast(`Delete failed: ${error.message}`, { variant: "error" });
    }
  }

  async function runAutomation(automation) {
    try {
      const result = await api.runTaskAutomation(taskId, automation.id);
      if (result?.skipped) pushToast(`Schedule skipped: ${result.reason}`, { variant: "info" });
      else pushToast("Scheduled run started", { variant: "success" });
      onChanged?.();
    } catch (error) {
      pushToast(`Run failed: ${error.message}`, { variant: "error" });
    }
  }

  const list = automations || [];
  return (
    <Card
      title={`Automations (${list.length})`}
      class="task-automations-card"
      headerRight={
        <Button size="sm" variant="secondary" iconLeft={<Icon name="plus" size={12} />} onClick={startNew}>
          Add
        </Button>
      }
    >
      {editingId && (
        <form class="task-automation-form" onSubmit={saveAutomation}>
          <ScheduleBuilder
            value={draft.trigger}
            disabled={saving}
            onChange={(trigger) => patchDraft({ trigger })}
          />
          <Checkbox
            checked={!!draft.enabled}
            onChange={(value) => patchDraft({ enabled: value })}
            label="Enabled"
            disabled={saving}
          />
          <Toolbar class="task-automation-form-actions">
            <Button type="button" size="sm" variant="ghost" onClick={cancelEdit} disabled={saving}>Cancel</Button>
            <Button type="submit" size="sm" variant="primary" loading={saving}>{editingId === "new" ? "Create" : "Save"}</Button>
          </Toolbar>
        </form>
      )}
      {loading ? (
        <div class="field-hint">Loading schedules...</div>
      ) : list.length === 0 ? (
        <div class="task-automations-empty">No schedules yet.</div>
      ) : (
        <SectionStack class="task-automation-list">
          {list.map((automation) => {
            const meta = automationOutcomeMeta(automation);
            const latest = automation.recent_triggers?.[0] || null;
            return (
              <div key={automation.id} class="task-automation-row">
                <div class="task-automation-main">
                  <span class={`chip ${meta.className}`} title={latest?.reason || undefined}>
                    <Icon name={meta.icon} size={10} /> {meta.label}
                  </span>
                  <span class="task-automation-trigger">{automation.trigger_summary}</span>
                  <span class="soft-meta">
                    {automation.next_fire_at ? `next ${formatDate(automation.next_fire_at)}` : "no upcoming run"}
                  </span>
                  {latest?.reason && <span class="task-automation-reason">{latest.reason}</span>}
                </div>
                <Toolbar class="task-automation-actions">
                  <Button size="sm" variant="ghost" iconLeft={<Icon name="play" size={12} />} onClick={() => runAutomation(automation)}>
                    Run
                  </Button>
                  <Button size="sm" variant="ghost" iconLeft={<Icon name="settings" size={12} />} onClick={() => startEdit(automation)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" iconLeft={<Icon name="trash" size={12} />} onClick={() => deleteAutomation(automation)}>
                    Delete
                  </Button>
                </Toolbar>
              </div>
            );
          })}
        </SectionStack>
      )}
    </Card>
  );
}

export function AgentRailRow({ role, value, onChange, agents, caption: captionOverride }) {
  const unassigned = !value;
  const roleLabel = role === "owner"
    ? "Owner"
    : role === "planner"
      ? "Planner"
      : "Reviewer";
  const caption = captionOverride || (role === "owner"
    ? (unassigned ? "Required for work" : "Runs work")
    : role === "planner"
      ? (unassigned ? "Falls back to owner" : "Runs planning")
      : (unassigned ? "Optional" : "Runs review"));
  return (
    <div class={`rail-agent-row${unassigned ? " unassigned" : ""}`}>
      <InlineHead class="rail-agent-row-head">
        <div>
          <div class="rail-agent-row-kicker">{roleLabel}</div>
        </div>
        <span class="rail-agent-row-caption">{caption}</span>
      </InlineHead>
      <AgentPicker
        class="rail-agent-picker"
        value={value || null}
        onChange={onChange}
        agents={agents}
        placeholder={`Assign ${roleLabel.toLowerCase()}`}
        role={roleLabel}
        ariaLabel={`Reassign ${roleLabel.toLowerCase()}`}
        allowClear
      />
    </div>
  );
}
