import { describe, expect, it } from "vitest";

import {
  nextFireAt,
  normalizeTrigger,
  triggerSummary,
  upcomingFireTimes,
} from "../../core/automations.js";

describe("automation trigger helpers", () => {
  it("normalizes webhook triggers with generated or supplied ids", () => {
    const generated = normalizeTrigger({ type: "webhook" });
    const custom = normalizeTrigger({ type: "webhook", webhook_id: "Custom_Id-123" });

    expect(generated).toMatchObject({ type: "webhook" });
    expect(generated.webhook_id).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(custom).toEqual({ type: "webhook", webhook_id: "Custom_Id-123" });
  });

  it("does not schedule webhook triggers on the cron clock", () => {
    const trigger = { type: "webhook", webhook_id: "Webhook_123" };

    expect(nextFireAt(trigger)).toBeNull();
    expect(upcomingFireTimes(trigger)).toEqual([]);
    expect(triggerSummary(trigger)).toBe("Webhook · Webhook_123");
  });
});
