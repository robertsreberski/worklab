/**
 * Build a structurally valid v2 envelope for Worklab boundary tests. Runtime
 * cryptography tests own authenticity; these fixtures exercise projection and
 * persistence without requiring a host key.
 */
function sealedPayload(raw) {
  const plaintext = Buffer.from(raw);
  if (plaintext.length === 0 || plaintext.length > 4_096) {
    throw new Error("ACP structural fixture raw value must contain 1-4096 bytes");
  }
  return Buffer.concat([
    Buffer.alloc(12, 0x6e),
    plaintext,
    Buffer.alloc(16, 0x74),
  ]).toString("base64url");
}

export function structuralAcpProviderSessionId(profileId, raw = "opaque-session") {
  return `acp:v2:${profileId}:${sealedPayload(raw)}`;
}

export function structuralAcpSessionCursor(profileId, raw = "opaque-cursor") {
  return `acp-cursor:v2:${profileId}:${sealedPayload(raw)}`;
}
