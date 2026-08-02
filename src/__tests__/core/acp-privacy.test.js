import { describe, expect, it } from "vitest";

import {
  createAcpEventPrivacyBoundary,
  validateAcpProviderSessionId,
} from "../../core/acp-privacy.js";

const PROFILE_ID = "profile-1";

function opaqueSessionId(raw = "remote-session") {
  return `acp:v1:${PROFILE_ID}:${Buffer.from(raw).toString("base64url")}`;
}

describe("ACP event privacy boundary", () => {
  it("accepts only canonical opaque provider session ids for the expected profile", () => {
    const valid = opaqueSessionId();

    expect(validateAcpProviderSessionId(valid, PROFILE_ID)).toBe(valid);
    expect(validateAcpProviderSessionId(valid, "profile-2")).toBeNull();
    expect(validateAcpProviderSessionId("raw-session", PROFILE_ID)).toBeNull();
    expect(validateAcpProviderSessionId(`acp:v1:${PROFILE_ID}:A`, PROFILE_ID)).toBeNull();
    expect(validateAcpProviderSessionId(null, PROFILE_ID)).toBeNull();
  });

  it("collects ids before copying, redacts them across events, and preserves opaque ids", () => {
    const rawSessionId = "RAW_REMOTE_SESSION";
    const malformedProviderId = "RAW_PROVIDER_SESSION";
    const providerSessionId = opaqueSessionId(rawSessionId);
    const boundary = createAcpEventPrivacyBoundary({ profileId: PROFILE_ID });

    const first = boundary.sanitizeEvent({
      type: "sdk_event",
      message: `same-event ${rawSessionId} ${malformedProviderId}`,
      [`key-${rawSessionId}`]: "value",
      nested: {
        sessionId: rawSessionId,
        provider_session_id: malformedProviderId,
        public_provider_session_id: providerSessionId,
      },
      providerSessionId,
    });
    const second = boundary.sanitizeEvent({
      type: "runtime_warning",
      message: `later ${rawSessionId} ${malformedProviderId}`,
    });

    expect(first).toMatchObject({
      type: "sdk_event",
      message: "same-event [redacted] [redacted]",
      "key-[redacted]": "value",
      nested: { public_provider_session_id: providerSessionId },
      providerSessionId,
    });
    expect(first.nested).not.toHaveProperty("sessionId");
    expect(first.nested).not.toHaveProperty("provider_session_id");
    expect(second.message).toBe("later [redacted] [redacted]");
    expect(JSON.stringify([first, second])).not.toMatch(/RAW_REMOTE_SESSION|RAW_PROVIDER_SESSION/u);
  });

  it("stays failed closed after an event exceeds the depth budget", () => {
    const failure = { type: "privacy_failure" };
    const boundary = createAcpEventPrivacyBoundary({
      profileId: PROFILE_ID,
      failureValue: failure,
    });
    let tooDeep = { sessionId: "deep-session" };
    for (let depth = 0; depth < 25; depth += 1) tooDeep = { nested: tooDeep };

    expect(boundary.sanitizeEvent(tooDeep)).toBe(failure);
    expect(boundary.failedClosed).toBe(true);
    expect(boundary.sanitizeEvent({ type: "final", text: "otherwise safe" })).toBe(failure);
  });
});
