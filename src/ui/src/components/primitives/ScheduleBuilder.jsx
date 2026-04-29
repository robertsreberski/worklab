import { Checkbox } from "./Checkbox.jsx";
import { DateTimePicker, localDateValue, localDateTimeToMs, localTimeValue } from "./DatePicker.jsx";
import { NumberStepper } from "./NumberStepper.jsx";
import { RadioGroup } from "./RadioGroup.jsx";
import { TimePicker } from "./DatePicker.jsx";

const TYPE_OPTIONS = [
  { value: "once", label: "Once" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
];

const WEEKDAYS = [
  { value: 0, short: "Sun", label: "Sunday" },
  { value: 1, short: "Mon", label: "Monday" },
  { value: 2, short: "Tue", label: "Tuesday" },
  { value: 3, short: "Wed", label: "Wednesday" },
  { value: 4, short: "Thu", label: "Thursday" },
  { value: 5, short: "Fri", label: "Friday" },
  { value: 6, short: "Sat", label: "Saturday" },
];

export function defaultScheduleRunAt(now = Date.now()) {
  const date = new Date(now + 3_600_000);
  date.setSeconds(0, 0);
  return date.getTime();
}

export function normalizeScheduleTrigger(trigger = {}, now = Date.now()) {
  const type = ["once", "daily", "weekly", "monthly"].includes(trigger?.type) ? trigger.type : "daily";
  if (type === "once") {
    const runAt = Number(trigger.run_at);
    return { type, run_at: Number.isFinite(runAt) ? runAt : defaultScheduleRunAt(now) };
  }
  const hour = Math.min(23, Math.max(0, Number.isFinite(Number(trigger.hour)) ? Number(trigger.hour) : 9));
  const minute = Math.min(59, Math.max(0, Number.isFinite(Number(trigger.minute)) ? Number(trigger.minute) : 0));
  if (type === "weekly") {
    const weekdays = Array.isArray(trigger.weekdays) && trigger.weekdays.length
      ? [...new Set(trigger.weekdays.map((day) => Math.min(6, Math.max(0, Number(day) || 0))))].sort((a, b) => a - b)
      : [1];
    return { type, hour, minute, weekdays };
  }
  if (type === "monthly") {
    return { type, hour, minute, day_of_month: Math.min(31, Math.max(1, Number(trigger.day_of_month) || 1)) };
  }
  return { type, hour, minute };
}

export function scheduleTimeValue(trigger = {}) {
  const normalized = normalizeScheduleTrigger(trigger);
  return `${String(normalized.hour ?? 9).padStart(2, "0")}:${String(normalized.minute ?? 0).padStart(2, "0")}`;
}

export function triggerWithTime(trigger = {}, timeValue = "09:00") {
  const [hour = "09", minute = "00"] = String(timeValue || "09:00").split(":");
  return normalizeScheduleTrigger({
    ...trigger,
    hour: Number(hour) || 0,
    minute: Number(minute) || 0,
  });
}

function triggerForType(current, type) {
  if (type === "once") return { type, run_at: current.run_at || defaultScheduleRunAt() };
  const time = current.type === "once"
    ? localTimeValue(current.run_at || defaultScheduleRunAt())
    : scheduleTimeValue(current);
  const [hour = "09", minute = "00"] = time.split(":");
  if (type === "weekly") return { type, hour: Number(hour), minute: Number(minute), weekdays: current.weekdays || [1] };
  if (type === "monthly") return { type, hour: Number(hour), minute: Number(minute), day_of_month: current.day_of_month || 1 };
  return { type, hour: Number(hour), minute: Number(minute) };
}

function nextWeekdays(current, day, checked) {
  const set = new Set(Array.isArray(current) ? current : []);
  if (checked) set.add(day);
  else set.delete(day);
  return [...set].sort((a, b) => a - b);
}

export function ScheduleBuilder({
  value = {},
  onChange,
  disabled = false,
  class: className = "",
}) {
  const trigger = normalizeScheduleTrigger(value);
  function commit(next) {
    onChange?.(normalizeScheduleTrigger(next));
  }
  const weekdayValues = trigger.type === "weekly" ? trigger.weekdays || [1] : [];
  const oneOffDate = trigger.type === "once"
    ? trigger.run_at
    : localDateTimeToMs(localDateValue(new Date()), scheduleTimeValue(trigger));

  return (
    <div class={`schedule-builder ${className}`.trim()}>
      <RadioGroup
        value={trigger.type}
        onChange={(type) => commit(triggerForType(trigger, type))}
        options={TYPE_OPTIONS}
        ariaLabel="Schedule cadence"
        class="schedule-builder-type"
      />

      {trigger.type === "once" ? (
        <div class="schedule-builder-row">
          <span class="schedule-builder-label">Run at</span>
          <DateTimePicker
            value={oneOffDate}
            disabled={disabled}
            onChange={(runAt) => commit({ type: "once", run_at: runAt })}
            ariaLabel="One-off run time"
          />
        </div>
      ) : (
        <div class="schedule-builder-row">
          <span class="schedule-builder-label">Time</span>
          <TimePicker
            value={scheduleTimeValue(trigger)}
            disabled={disabled}
            onChange={(time) => commit(triggerWithTime(trigger, time))}
            ariaLabel="Schedule time in UTC"
          />
          <span class="schedule-builder-zone">UTC</span>
        </div>
      )}

      {trigger.type === "weekly" && (
        <div class="schedule-weekdays" role="group" aria-label="Weekdays">
          {WEEKDAYS.map((day) => (
            <Checkbox
              key={day.value}
              checked={weekdayValues.includes(day.value)}
              disabled={disabled}
              label={day.short}
              onChange={(checked) => {
                const weekdays = nextWeekdays(weekdayValues, day.value, checked);
                commit({ ...trigger, weekdays: weekdays.length ? weekdays : [day.value] });
              }}
            />
          ))}
        </div>
      )}

      {trigger.type === "monthly" && (
        <div class="schedule-builder-row">
          <span class="schedule-builder-label">Day</span>
          <NumberStepper
            value={trigger.day_of_month || 1}
            min={1}
            max={31}
            disabled={disabled}
            ariaLabel="Day of month"
            onChange={(day) => commit({ ...trigger, day_of_month: day })}
          />
        </div>
      )}
    </div>
  );
}
