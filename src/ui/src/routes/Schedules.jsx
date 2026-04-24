import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api } from "../lib/api.js";
import { AppShell } from "../components/AppShell.jsx";
import { PaneLayout } from "../components/PaneLayout.jsx";
import { PaneRow } from "../components/PaneRow.jsx";
import { SearchField } from "../components/primitives/SearchField.jsx";
import { Button } from "../components/primitives/Button.jsx";
import { Input } from "../components/primitives/Input.jsx";
import { Select } from "../components/primitives/Select.jsx";
import { Switch } from "../components/primitives/Switch.jsx";
import { RadioGroup } from "../components/primitives/RadioGroup.jsx";
import { Banner } from "../components/Banner.jsx";
import { FormSection } from "../components/FormSection.jsx";
import { FormGrid } from "../components/FormGrid.jsx";
import { FormField } from "../components/FormField.jsx";
import { Textarea } from "../components/primitives/Textarea.jsx";
import { Chip } from "../components/primitives/Chip.jsx";
import { AgentPicker } from "../components/AgentPicker.jsx";
import { EmptyState, EmptyStateFiltered } from "../components/EmptyState.jsx";
import { LoadingState } from "../components/LoadingState.jsx";
import { Card } from "../components/Card.jsx";
import { Modal } from "../components/Modal.jsx";
import { Icon } from "../components/Icon.jsx";
import { StatusPill } from "../components/primitives/StatusPill.jsx";
import { pushToast } from "../lib/toast.js";
import { useFormSave } from "../lib/useFormSave.js";
import { navigateHash, useUnsavedChangesGuard } from "../lib/navigation.js";
import { useGlobalShortcuts } from "../lib/useGlobalShortcuts.js";
import { useSSE } from "../lib/useSSE.js";

const DEFAULT_FORM = {
  title: "",
  instructions: "",
  executor_agent: null,
  reviewer_agent: null,
  tags: [],
  enabled: true,
  cadence: {
    type: "daily",
    hour: 9,
    minute: 0,
  },
};

const CADENCE_OPTIONS = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
];

const WEEKDAY_OPTIONS = [
  { value: "0", label: "Sunday" },
  { value: "1", label: "Monday" },
  { value: "2", label: "Tuesday" },
  { value: "3", label: "Wednesday" },
  { value: "4", label: "Thursday" },
  { value: "5", label: "Friday" },
  { value: "6", label: "Saturday" },
];

function pad2(value) {
  return String(value).padStart(2, "0");
}

function timeValue(cadence) {
  return `${pad2(cadence?.hour ?? 9)}:${pad2(cadence?.minute ?? 0)}`;
}

function updateCadenceTime(cadence, value) {
  const [hour = "09", minute = "00"] = String(value || "").split(":");
  return {
    ...cadence,
    hour: Number(hour) || 0,
    minute: Number(minute) || 0,
  };
}

function normalizeCadence(cadence) {
  const type = cadence?.type || "daily";
  const next = {
    type,
    hour: cadence?.hour ?? 9,
    minute: cadence?.minute ?? 0,
  };
  if (type === "weekly") next.weekdays = cadence?.weekdays?.length ? cadence.weekdays : [1];
  if (type === "monthly") next.day_of_month = cadence?.day_of_month || 1;
  return next;
}

function formatDateTime(value) {
  return value ? new Date(value).toLocaleString() : "—";
}

function ScheduleEdit({ scheduleId, agents, onSaved, onDeleted }) {
  const isNew = scheduleId === "new";
  const [form, setForm] = useState(DEFAULT_FORM);
  const [baseline, setBaseline] = useState(DEFAULT_FORM);
  const [loading, setLoading] = useState(!isNew);
  const [notFound, setNotFound] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  const [recentTasks, setRecentTasks] = useState([]);
  const [upcomingFires, setUpcomingFires] = useState([]);

  const reload = useCallback(() => {
    if (isNew) {
      setForm(DEFAULT_FORM);
      setBaseline(DEFAULT_FORM);
      setRecentTasks([]);
      setUpcomingFires([]);
      setLoading(false);
      setNotFound(false);
      return;
    }
    setLoading(true);
    api.getSchedule(scheduleId)
      .then((response) => {
        const next = {
          title: response.schedule.title || "",
          instructions: response.schedule.instructions || "",
          executor_agent: response.schedule.executor_agent || null,
          reviewer_agent: response.schedule.reviewer_agent || null,
          tags: response.schedule.tags || [],
          enabled: response.schedule.enabled !== false,
          cadence: normalizeCadence(response.schedule.cadence),
        };
        setForm(next);
        setBaseline(next);
        setRecentTasks(response.recent_tasks || []);
        setUpcomingFires(response.schedule.upcoming_fires || []);
        setNotFound(false);
      })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [isNew, scheduleId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const isDirty = useMemo(
    () => JSON.stringify(form) !== JSON.stringify(baseline),
    [baseline, form],
  );

  const formSave = useFormSave(async () => {
    const payload = {
      ...form,
      title: form.title.trim(),
      cadence: normalizeCadence(form.cadence),
    };
    if (isNew) {
      const response = await api.createSchedule(payload);
      pushToast("Schedule created", { variant: "success" });
      onSaved?.(response.schedule.id);
      return response.schedule.id;
    }
    const response = await api.patchSchedule(scheduleId, payload);
    pushToast("Saved.", { variant: "success" });
    const next = {
      title: response.schedule.title || "",
      instructions: response.schedule.instructions || "",
      executor_agent: response.schedule.executor_agent || null,
      reviewer_agent: response.schedule.reviewer_agent || null,
      tags: response.schedule.tags || [],
      enabled: response.schedule.enabled !== false,
      cadence: normalizeCadence(response.schedule.cadence),
    };
    setForm(next);
    setBaseline(next);
    setRecentTasks(response.recent_tasks || []);
    setUpcomingFires(response.schedule.upcoming_fires || []);
    onSaved?.(scheduleId);
    return scheduleId;
  });

  const guard = useUnsavedChangesGuard({ isDirty, onSave: () => formSave.save() });

  useGlobalShortcuts({
    cmds: (event) => {
      event.preventDefault();
      formSave.save().catch(() => {});
    },
  });

  function update(patch) {
    setForm((current) => ({ ...current, ...patch }));
  }

  function commitTagDraft() {
    const value = tagDraft.trim();
    if (!value) return;
    if (form.tags.includes(value)) {
      setTagDraft("");
      return;
    }
    update({ tags: [...form.tags, value] });
    setTagDraft("");
  }

  function removeTag(tag) {
    update({ tags: form.tags.filter((entry) => entry !== tag) });
  }

  async function destroy() {
    try {
      await api.deleteSchedule(scheduleId);
      pushToast("Schedule deleted", { variant: "success" });
      onDeleted?.();
    } catch (error) {
      pushToast(`Delete failed: ${error.message}`, { variant: "error" });
    }
  }

  async function spawnNow() {
    try {
      const response = await api.runSchedule(scheduleId);
      pushToast("Task spawned", { variant: "success" });
      reload();
      navigateHash(`#/tasks/${response.task.id}`);
    } catch (error) {
      pushToast(`Manual spawn failed: ${error.message}`, { variant: "error" });
    }
  }

  if (loading) return <LoadingState caption="Loading schedule…" />;
  if (notFound) {
    return (
      <div class="pane-empty">
        <h3>Schedule not found</h3>
        <p>It may have been deleted.</p>
      </div>
    );
  }

  return (
    <>
      <header class="pane-detail-head">
        <div class="pane-detail-head-titles">
          <div class="all-caps">{isNew ? "Create schedule" : "Schedule"}</div>
          <h2>{isNew ? "New schedule" : form.title}</h2>
        </div>
        <div class="toolbar">
          {!isNew && <StatusPill status={form.enabled ? "enabled" : "disabled"} size="sm" />}
          {!isNew && (
            <Button variant="secondary" size="sm" iconLeft={<Icon name="play" size={13} />} onClick={spawnNow}>
              Spawn task
            </Button>
          )}
          {!isNew && (
            <Button variant="destructive" size="sm" iconLeft={<Icon name="trash" size={13} />} onClick={() => setDeleteOpen(true)}>
              Delete
            </Button>
          )}
          <Button
            variant={isDirty || isNew ? "primary" : "secondary"}
            loading={formSave.saving}
            onClick={() => formSave.save().catch(() => {})}
            disabled={!form.title.trim()}
          >
            {isNew ? "Create" : "Save"}
          </Button>
        </div>
      </header>

      <div class="pane-detail-body">
        {formSave.error && (
          <Banner
            variant="error"
            title="Save failed"
            detail={formSave.error}
            actions={<Button size="sm" onClick={() => formSave.save().catch(() => {})}>Retry</Button>}
          />
        )}

        <FormSection kicker="Cadence" title="When this should fire">
          <FormGrid columns={2}>
            <FormField label="Title" required class="span-2">
              <Input value={form.title} onInput={(event) => update({ title: event.target.value })} placeholder="Weekly quality sweep" />
            </FormField>
            <FormField label="Cadence type" class="span-2">
              <RadioGroup
                ariaLabel="Cadence type"
                value={form.cadence.type}
                onChange={(value) => update({ cadence: normalizeCadence({ ...form.cadence, type: value }) })}
                options={CADENCE_OPTIONS}
              />
            </FormField>
            <FormField label="Time (UTC)">
              <Input type="time" value={timeValue(form.cadence)} onInput={(event) => update({ cadence: updateCadenceTime(form.cadence, event.target.value) })} />
            </FormField>
            {form.cadence.type === "weekly" && (
              <FormField label="Day of week">
                <Select
                  variant="native"
                  value={String(form.cadence.weekdays?.[0] ?? 1)}
                  onChange={(value) => update({ cadence: { ...form.cadence, weekdays: [Number(value)] } })}
                  options={WEEKDAY_OPTIONS}
                  ariaLabel="Choose weekday"
                />
              </FormField>
            )}
            {form.cadence.type === "monthly" && (
              <FormField label="Day of month">
                <Input
                  type="number"
                  min="1"
                  max="31"
                  value={String(form.cadence.day_of_month || 1)}
                  onInput={(event) => update({ cadence: { ...form.cadence, day_of_month: Number(event.target.value) || 1 } })}
                />
              </FormField>
            )}
            <FormField switchInside class="span-2">
              <Switch
                checked={!!form.enabled}
                onChange={(value) => update({ enabled: value })}
                label="Enabled"
                description="Disabled schedules keep their template but stop spawning tasks."
              />
            </FormField>
          </FormGrid>
        </FormSection>

        <FormSection kicker="Template" title="What gets spawned">
          <FormField label="Instructions" class="span-2" hint="Passed verbatim into each spawned task.">
            <Textarea rows={8} autoGrow monospace value={form.instructions} onInput={(event) => update({ instructions: event.target.value })} />
          </FormField>
        </FormSection>

        <FormSection kicker="Assignment" title="Who owns the spawned work">
          <FormGrid columns={2}>
            <FormField label="Executor">
              <AgentPicker
                value={form.executor_agent}
                onChange={(value) => update({ executor_agent: value })}
                agents={agents}
                placeholder="Pick an executor"
              />
            </FormField>
            <FormField label="Reviewer">
              <AgentPicker
                value={form.reviewer_agent}
                onChange={(value) => update({ reviewer_agent: value })}
                agents={agents}
                placeholder="Pick a reviewer"
              />
            </FormField>
            <FormField label="Tags" hint="Press Enter to add a tag." class="span-2">
              <div class="tag-input-row">
                {(form.tags || []).map((tag) => (
                  <Chip key={tag} variant="tag" onRemove={() => removeTag(tag)}>{tag}</Chip>
                ))}
                <Input
                  placeholder="Add tag…"
                  value={tagDraft}
                  onInput={(event) => setTagDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === ",") {
                      event.preventDefault();
                      commitTagDraft();
                    } else if (event.key === "Backspace" && !tagDraft && form.tags.length) {
                      removeTag(form.tags[form.tags.length - 1]);
                    }
                  }}
                  onBlur={commitTagDraft}
                />
              </div>
            </FormField>
          </FormGrid>
        </FormSection>

        {!isNew && (
          <>
            <Card title="Upcoming fires">
              <div class="schedule-list">
                {upcomingFires.map((fireAt) => (
                  <div key={fireAt} class="schedule-list-row">
                    <span>{formatDateTime(fireAt)}</span>
                  </div>
                ))}
              </div>
            </Card>

            <Card title="Recent spawned tasks">
              {recentTasks.length === 0 ? (
                <div class="field-hint">No tasks spawned yet.</div>
              ) : (
                <div class="schedule-list">
                  {recentTasks.map((task) => (
                    <a key={task.id} class="schedule-list-row" href={`#/tasks/${task.id}`}>
                      <span class="truncate">{task.title}</span>
                      <span class="schedule-list-row-meta">
                        <span class="soft-meta">{task.trigger_type}</span>
                        <StatusPill status={task.status} size="sm" />
                      </span>
                    </a>
                  ))}
                </div>
              )}
            </Card>
          </>
        )}
      </div>

      <Modal
        open={guard.promptOpen}
        onClose={guard.keepEditing}
        title="You have unsaved changes"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={guard.keepEditing}>Keep editing</Button>
            <Button variant="destructive" onClick={guard.discardAndLeave}>Discard</Button>
            <Button variant="primary" loading={formSave.saving} onClick={() => guard.saveAndLeave().catch(() => {})}>Save & leave</Button>
          </>
        }
      >
        <p>Your schedule changes have not been saved.</p>
      </Modal>

      <Modal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title={`Delete "${form.title}"?`}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={() => { setDeleteOpen(false); destroy(); }}>Delete</Button>
          </>
        }
      >
        <p>This removes the schedule template but leaves already spawned tasks intact.</p>
      </Modal>
    </>
  );
}

export function Schedules({ selectedId = null }) {
  const [schedules, setSchedules] = useState(null);
  const [agents, setAgents] = useState([]);
  const [query, setQuery] = useState("");
  const searchRef = useRef(null);

  const reload = useCallback(() => {
    api.listSchedules()
      .then((response) => setSchedules(response.schedules || []))
      .catch(() => setSchedules([]));
  }, []);

  useEffect(() => {
    reload();
    api.listAgents().then((response) => setAgents(response.agents || [])).catch(() => setAgents([]));
  }, [reload]);

  useSSE("global", (event) => {
    if (["schedule_created", "schedule_updated", "schedule_deleted", "schedule_triggered"].includes(event.type)) {
      reload();
    }
  });

  useGlobalShortcuts({
    "/": (event) => {
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select?.();
    },
  });

  const filtered = useMemo(() => {
    const value = query.trim().toLowerCase();
    if (!value) return schedules || [];
    return (schedules || []).filter((schedule) => {
      return (
        schedule.title?.toLowerCase().includes(value) ||
        schedule.cadence_summary?.toLowerCase().includes(value)
      );
    });
  }, [query, schedules]);

  const listHeader = (
    <>
      <SearchField
        value={query}
        onInput={(event) => setQuery(event.target.value)}
        placeholder="Search schedules…"
        shortcut="/"
        ariaLabel="Search schedules"
        inputRef={searchRef}
      />
      <div class="toolbar">
        <Button variant="primary" iconLeft={<Icon name="plus" size={13} />} onClick={() => navigateHash("#/schedules/new")}>
          New schedule
        </Button>
      </div>
    </>
  );

  const listBody = schedules === null ? (
    <LoadingState caption="Loading schedules…" />
  ) : filtered.length === 0 ? (
    query.trim() ? (
      <EmptyStateFiltered
        title="No schedules match your filter"
        body="Try a different search or clear the filter."
        onClearFilters={() => setQuery("")}
      />
    ) : (
      <EmptyState
        icon={<Icon name="calendar" size={48} />}
        title="No schedules yet"
        body="Create your first recurring task template."
        cta={<Button variant="primary" onClick={() => navigateHash("#/schedules/new")}>Create schedule</Button>}
      />
    )
  ) : (
    filtered.map((schedule) => (
      <PaneRow
        key={schedule.id}
        href={`#/schedules/${schedule.id}`}
        active={selectedId === schedule.id}
        onClick={(event) => {
          event.preventDefault();
          navigateHash(`#/schedules/${schedule.id}`);
        }}
        leading={<Icon name="calendar" size={14} />}
        title={schedule.title}
        sub={`${schedule.cadence_summary} · next ${schedule.next_fire_at ? new Date(schedule.next_fire_at).toLocaleString() : "paused"}`}
        trailing={
          <div class="pane-row-summary">
            <StatusPill status={schedule.enabled ? "enabled" : "disabled"} size="sm" />
            <span>{schedule.recent_30d_count} fires</span>
          </div>
        }
      />
    ))
  );

  const detail = selectedId ? (
    <ScheduleEdit
      key={selectedId}
      scheduleId={selectedId}
      agents={agents}
      onSaved={(savedId) => navigateHash(`#/schedules/${savedId}`)}
      onDeleted={() => navigateHash("#/schedules")}
    />
  ) : (
    <div class="pane-empty">
      <Icon name="calendar" size={40} />
      <h3>Select a schedule</h3>
      <p>Choose one from the list or create a new recurring template.</p>
    </div>
  );

  return (
    <AppShell route="schedules" title="Schedules">
      <PaneLayout
        listHeader={listHeader}
        listBody={listBody}
        detail={detail}
        hasSelection={!!selectedId}
        onBack={() => navigateHash("#/schedules")}
        backLabel="All schedules"
      />
    </AppShell>
  );
}
