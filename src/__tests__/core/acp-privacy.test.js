import { describe, expect, it } from "vitest";

import {
  createAcpEventPrivacyBoundary,
  validateAcpProviderSessionId,
} from "../../core/acp-privacy.js";

const PROFILE_ID = "profile-1";
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function opaqueSessionId(raw = "remote-session") {
  const sealed = Buffer.concat([
    Buffer.alloc(12, 0x6e),
    Buffer.from(raw),
    Buffer.alloc(16, 0x74),
  ]);
  return `acp:v2:${PROFILE_ID}:${sealed.toString("base64url")}`;
}

function opaqueCursor(raw = "remote-cursor") {
  const sealed = Buffer.concat([
    Buffer.alloc(12, 0x6e),
    Buffer.from(raw),
    Buffer.alloc(16, 0x74),
  ]);
  return `acp-cursor:v2:${PROFILE_ID}:${sealed.toString("base64url")}`;
}

function nonCanonicalBase64url(value) {
  const index = BASE64URL_ALPHABET.indexOf(value.at(-1));
  return `${value.slice(0, -1)}${BASE64URL_ALPHABET[index + 1]}`;
}

describe("ACP event privacy boundary", () => {
  it("accepts only canonical opaque provider session ids for the expected profile", () => {
    const valid = opaqueSessionId();

    expect(validateAcpProviderSessionId(valid, PROFILE_ID)).toBe(valid);
    expect(validateAcpProviderSessionId(valid, "profile-2")).toBeNull();
    expect(validateAcpProviderSessionId("raw-session", PROFILE_ID)).toBeNull();
    expect(validateAcpProviderSessionId(
      `acp:v1:${PROFILE_ID}:${Buffer.from("legacy").toString("base64url")}`,
      PROFILE_ID,
    )).toBeNull();
    expect(validateAcpProviderSessionId(
      `acp:v2:${PROFILE_ID}:${Buffer.alloc(28).toString("base64url")}`,
      PROFILE_ID,
    )).toBeNull();
    expect(validateAcpProviderSessionId(
      `acp:v2:${PROFILE_ID}:${Buffer.alloc(4_125).toString("base64url")}`,
      PROFILE_ID,
    )).toBeNull();
    expect(validateAcpProviderSessionId(
      nonCanonicalBase64url(opaqueSessionId("x")),
      PROFILE_ID,
    )).toBeNull();
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

  it("preserves structurally valid v2 handles without decoding their sealed bytes", () => {
    const sealedText = `${"n".repeat(12)}RAW_CIPHERTEXT_BYTES${"t".repeat(16)}`;
    const providerSessionId = `acp:v2:${PROFILE_ID}:${Buffer.from(sealedText).toString("base64url")}`;
    const boundary = createAcpEventPrivacyBoundary({ profileId: PROFILE_ID });

    const sanitized = boundary.sanitizeEvent({
      type: "final",
      text: `completed ${sealedText}`,
      diagnostics: { message: sealedText },
      provider_session_id: providerSessionId,
    });

    expect(sanitized).toEqual({
      type: "final",
      text: `completed ${sealedText}`,
      diagnostics: { message: sealedText },
      provider_session_id: providerSessionId,
    });
  });

  it("collects every cursor alias before preserving only the prioritized opaque cursor", () => {
    const rawCursor = "RAW_CURSOR_FROM_HANDLE";
    const rawPageCursor = "RAW_PAGE_CURSOR";
    const rawPageToken = "RAW_PAGE_TOKEN";
    const cursor = opaqueCursor(rawCursor);
    const boundary = createAcpEventPrivacyBoundary({
      profileId: PROFILE_ID,
      includeCursors: true,
    });

    expect(boundary.sanitizeEvent({
      pageCursor: rawPageCursor,
      "next-page-cursor": cursor,
      page_token: rawPageToken,
      note: `${rawCursor} ${rawPageCursor} ${rawPageToken}`,
    })).toEqual({
      "next-page-cursor": cursor,
      note: `${rawCursor} [redacted] [redacted]`,
    });
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
    expect(boundary.redactText("untrusted stderr after failure")).toBe("[redacted]");
  });

  it("fails closed on non-string session identifier fields", () => {
    const failure = { type: "privacy_failure" };
    const boundary = createAcpEventPrivacyBoundary({
      profileId: PROFILE_ID,
      failureValue: failure,
    });

    expect(boundary.sanitizeEvent({ type: "event", sessionId: { hidden: "raw" } })).toBe(failure);
    expect(boundary.failedClosed).toBe(true);
  });
});
