import { describe, expect, it } from "vitest";
import {
  localDateTimeToMs,
  localDateValue,
  localTimeValue,
  msToLocalDateTime,
} from "../../ui/src/components/primitives/DatePicker.jsx";
import {
  normalizeScheduleTrigger,
  scheduleTimeValue,
  triggerWithTime,
} from "../../ui/src/components/primitives/ScheduleBuilder.jsx";
import {
  automationWebhookUrl,
  normalizeTaskAutomationTrigger,
} from "../../ui/src/routes/task-detail/WorkflowCards.jsx";

describe("domain date and schedule inputs", () => {
  it("round-trips local date and time values through epoch milliseconds", () => {
    const ms = localDateTimeToMs("2026-04-29", "09:15");
    const date = new Date(ms);
    expect(localDateValue(date)).toBe("2026-04-29");
    expect(localTimeValue(date)).toBe("09:15");
    expect(msToLocalDateTime(ms)).toEqual({ date: "2026-04-29", time: "09:15" });
  });

  it("normalizes schedule triggers to the existing API contract", () => {
    expect(normalizeScheduleTrigger({ type: "weekly", weekdays: [3, 1, 3], hour: 30, minute: -2 })).toEqual({
      type: "weekly",
      weekdays: [1, 3],
      hour: 23,
      minute: 0,
    });
    expect(normalizeScheduleTrigger({ type: "monthly", day_of_month: 99, hour: 8, minute: 5 })).toEqual({
      type: "monthly",
      day_of_month: 31,
      hour: 8,
      minute: 5,
    });
  });

  it("updates recurring schedule time without changing cadence fields", () => {
    const trigger = triggerWithTime({ type: "weekly", weekdays: [2, 4] }, "07:45");
    expect(trigger).toMatchObject({ type: "weekly", weekdays: [2, 4], hour: 7, minute: 45 });
    expect(scheduleTimeValue(trigger)).toBe("07:45");
  });

  it("preserves webhook automation triggers without schedule normalization", () => {
    expect(normalizeTaskAutomationTrigger({ type: "webhook", webhook_id: " Hook_123 " }))
      .toEqual({ type: "webhook", webhook_id: "Hook_123" });
    expect(normalizeTaskAutomationTrigger({ type: "webhook" }))
      .toEqual({ type: "webhook" });
    expect(automationWebhookUrl({ trigger: { type: "webhook", webhook_id: "Hook_123" } }, "http://localhost:7878"))
      .toBe("http://localhost:7878/api/webhooks/Hook_123");
  });
});
