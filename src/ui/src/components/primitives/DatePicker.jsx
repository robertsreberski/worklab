import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Icon } from "../Icon.jsx";
import { IconButton } from "./IconButton.jsx";
import { Button } from "./Button.jsx";

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MONTH_FORMATTER = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });

export function pad2(value) {
  return String(value).padStart(2, "0");
}

export function localDateValue(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(d.getTime())) return "";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function localTimeValue(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(d.getTime())) return "09:00";
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function parseDateValue(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (
    date.getFullYear() !== Number(match[1]) ||
    date.getMonth() !== Number(match[2]) - 1 ||
    date.getDate() !== Number(match[3])
  ) return null;
  return date;
}

export function localDateTimeToMs(dateValue, timeValue = "00:00") {
  const date = parseDateValue(dateValue);
  if (!date) return null;
  const [hour = "0", minute = "0"] = String(timeValue || "00:00").split(":");
  date.setHours(Number(hour) || 0, Number(minute) || 0, 0, 0);
  return date.getTime();
}

export function msToLocalDateTime(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms)) return { date: "", time: "09:00" };
  const date = new Date(ms);
  return { date: localDateValue(date), time: localTimeValue(date) };
}

function addDays(date, amount) {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

function monthStart(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function monthKey(date) {
  return `${date.getFullYear()}-${date.getMonth()}`;
}

function calendarDays(monthDate) {
  const start = monthStart(monthDate);
  const first = addDays(start, -start.getDay());
  return Array.from({ length: 42 }, (_, index) => addDays(first, index));
}

export function DatePicker({
  value = "",
  onChange,
  disabled = false,
  placeholder = "Select date",
  ariaLabel = "Select date",
  class: className = "",
}) {
  const rootRef = useRef(null);
  const selectedDate = parseDateValue(value);
  const [open, setOpen] = useState(false);
  const [viewDate, setViewDate] = useState(selectedDate || new Date());
  const [focusValue, setFocusValue] = useState(value || localDateValue(new Date()));

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (selectedDate) {
      setViewDate(selectedDate);
      setFocusValue(value);
    }
  }, [selectedDate?.getTime(), value]);

  const days = useMemo(() => calendarDays(viewDate), [monthKey(viewDate)]);
  const label = selectedDate ? selectedDate.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : placeholder;

  function choose(date) {
    onChange?.(localDateValue(date));
    setFocusValue(localDateValue(date));
    setOpen(false);
  }

  function moveMonth(delta) {
    setViewDate((current) => new Date(current.getFullYear(), current.getMonth() + delta, 1));
  }

  function onDayKeyDown(event, date) {
    const moves = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
    };
    if (event.key in moves) {
      event.preventDefault();
      const next = addDays(date, moves[event.key]);
      setViewDate(next);
      setFocusValue(localDateValue(next));
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(date);
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div ref={rootRef} class={`date-picker ${open ? "open" : ""} ${className}`.trim()}>
      <button
        type="button"
        class={`date-picker-trigger input ${selectedDate ? "" : "date-picker-placeholder"}`.trim()}
        aria-label={ariaLabel}
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <Icon name="calendar" size={14} />
        <span>{label}</span>
        <Icon name="chevron-down" size={14} class="date-picker-chev" />
      </button>
      {open && (
        <div class="date-picker-popover" role="dialog" aria-label={ariaLabel}>
          <div class="date-picker-head">
            <IconButton
              size="sm"
              icon={<Icon name="chevron-left" size={13} />}
              aria-label="Previous month"
              onClick={() => moveMonth(-1)}
            />
            <div class="date-picker-month">{MONTH_FORMATTER.format(viewDate)}</div>
            <IconButton
              size="sm"
              icon={<Icon name="chevron-right" size={13} />}
              aria-label="Next month"
              onClick={() => moveMonth(1)}
            />
          </div>
          <div class="date-picker-grid date-picker-weekdays" aria-hidden="true">
            {WEEKDAYS.map((day) => <span key={day}>{day}</span>)}
          </div>
          <div class="date-picker-grid">
            {days.map((day) => {
              const dayValue = localDateValue(day);
              const selected = dayValue === value;
              const muted = day.getMonth() !== viewDate.getMonth();
              const today = dayValue === localDateValue(new Date());
              return (
                <button
                  key={dayValue}
                  type="button"
                  class={`date-picker-day ${selected ? "selected" : ""} ${muted ? "muted" : ""} ${today ? "today" : ""}`.trim()}
                  tabIndex={dayValue === focusValue ? 0 : -1}
                  aria-pressed={selected ? "true" : "false"}
                  onClick={() => choose(day)}
                  onKeyDown={(event) => onDayKeyDown(event, day)}
                >
                  {day.getDate()}
                </button>
              );
            })}
          </div>
          <div class="date-picker-foot">
            <Button size="sm" variant="ghost" onClick={() => onChange?.("")}>Clear</Button>
            <Button size="sm" variant="secondary" onClick={() => choose(new Date())}>Today</Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function DateTimePicker({
  value,
  onChange,
  disabled = false,
  ariaLabel = "Select date and time",
  class: className = "",
}) {
  const parts = msToLocalDateTime(value);
  function commit(next) {
    const ms = localDateTimeToMs(next.date || parts.date || localDateValue(new Date()), next.time || parts.time || "09:00");
    if (ms != null) onChange?.(ms);
  }
  return (
    <div class={`date-time-picker ${className}`.trim()} aria-label={ariaLabel}>
      <DatePicker
        value={parts.date}
        onChange={(date) => commit({ date, time: parts.time })}
        disabled={disabled}
        ariaLabel={`${ariaLabel}: date`}
      />
      <TimePicker
        value={parts.time}
        onChange={(time) => commit({ date: parts.date, time })}
        disabled={disabled}
        ariaLabel={`${ariaLabel}: time`}
      />
    </div>
  );
}

export function TimePicker({
  value = "09:00",
  onChange,
  disabled = false,
  step = 15,
  ariaLabel = "Select time",
  class: className = "",
}) {
  function normalize(nextValue) {
    const match = String(nextValue || "").match(/^(\d{1,2}):?(\d{0,2})$/);
    if (!match) return value || "09:00";
    const hour = Math.min(23, Math.max(0, Number(match[1]) || 0));
    const minute = Math.min(59, Math.max(0, Number(match[2] || 0) || 0));
    return `${pad2(hour)}:${pad2(minute)}`;
  }
  function stepTime(delta) {
    const [hour = "0", minute = "0"] = String(value || "09:00").split(":");
    const total = ((Number(hour) || 0) * 60) + (Number(minute) || 0) + delta * step;
    const wrapped = ((total % 1440) + 1440) % 1440;
    onChange?.(`${pad2(Math.floor(wrapped / 60))}:${pad2(wrapped % 60)}`);
  }
  return (
    <div class={`time-picker ${className}`.trim()}>
      <Icon name="clock" size={14} class="time-picker-icon" />
      <input
        type="text"
        inputMode="numeric"
        class="time-picker-input"
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        onInput={(event) => onChange?.(event.currentTarget.value)}
        onBlur={(event) => onChange?.(normalize(event.currentTarget.value))}
      />
      <div class="time-picker-steps" aria-hidden="true">
        <button type="button" tabIndex={-1} disabled={disabled} onClick={() => stepTime(1)}>+</button>
        <button type="button" tabIndex={-1} disabled={disabled} onClick={() => stepTime(-1)}>-</button>
      </div>
    </div>
  );
}

export function DateRangePicker({
  value = {},
  onChange,
  disabled = false,
  class: className = "",
}) {
  const today = localDateValue(new Date());
  const last7 = localDateValue(addDays(new Date(), -6));
  function patch(patchValue) {
    onChange?.({ from: value.from || "", to: value.to || "", ...patchValue });
  }
  return (
    <div class={`date-range-picker ${className}`.trim()}>
      <div class="date-range-fields">
        <DatePicker value={value.from || ""} onChange={(from) => patch({ from })} disabled={disabled} ariaLabel="From date" placeholder="From" />
        <DatePicker value={value.to || ""} onChange={(to) => patch({ to })} disabled={disabled} ariaLabel="To date" placeholder="To" />
      </div>
      <div class="date-range-presets">
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onChange?.({ from: today, to: today })}>Today</Button>
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onChange?.({ from: last7, to: today })}>7 days</Button>
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onChange?.({ from: "", to: "" })}>Clear</Button>
      </div>
    </div>
  );
}
