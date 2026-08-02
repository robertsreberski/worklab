import { describe, expect, it } from "vitest";

import { validateSetting } from "../../core/settings.js";

describe("assistant and Slack model settings", () => {
  it.each(["assistant_model", "slack_model"])(
    "rejects task-only ACP references for %s",
    (key) => {
      expect(() => validateSetting(key, "acp:profile-a"))
        .toThrow(`${key} must be a valid model reference`);
    },
  );

  it.each(["assistant_model", "slack_model"])(
    "preserves provider-backed references for %s",
    (key) => {
      expect(validateSetting(key, "openai:gpt-5.5")).toBe("pi:openai:gpt-5.5");
    },
  );
});
