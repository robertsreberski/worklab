import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  _resetForTests,
  decrypt,
  encrypt,
  getAcpSessionTokenKey,
  getKeyFingerprint,
} from "../../core/crypto.js";

let dataDir;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "worklab-crypto-"));
  delete process.env.PROVIDER_ENCRYPTION_KEY;
  _resetForTests();
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.PROVIDER_ENCRYPTION_KEY;
  _resetForTests();
});

describe("provider credential crypto", () => {
  it("auto-generates a key file and encrypts/decrypts", () => {
    const payload = encrypt("sk-test", { dataDir });
    expect(decrypt(payload, { dataDir })).toBe("sk-test");
    const keyPath = join(dataDir, ".provider-encryption-key");
    expect(existsSync(keyPath)).toBe(true);
    expect(readFileSync(keyPath).length).toBe(32);
  });

  it("uses a fresh IV per encryption", () => {
    const a = encrypt("same", { dataDir });
    const b = encrypt("same", { dataDir });
    expect(a).not.toBe(b);
    expect(decrypt(a, { dataDir })).toBe("same");
    expect(decrypt(b, { dataDir })).toBe("same");
  });

  it("rejects tampered payloads", () => {
    const payload = Buffer.from(encrypt("secret", { dataDir }), "base64");
    payload[14] ^= 0xff;
    expect(() => decrypt(payload.toString("base64"), { dataDir })).toThrow();
  });

  it("env key rotation makes old API keys unreadable", () => {
    process.env.PROVIDER_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    _resetForTests();
    const payload = encrypt("secret", { dataDir });
    const firstFingerprint = getKeyFingerprint({ dataDir });

    process.env.PROVIDER_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    _resetForTests();
    expect(getKeyFingerprint({ dataDir })).not.toBe(firstFingerprint);
    expect(() => decrypt(payload, { dataDir })).toThrow();
  });

  it("derives a stable isolated ACP session-token key and returns defensive copies", () => {
    const first = getAcpSessionTokenKey({ dataDir });
    expect(first).toHaveLength(32);
    first.fill(0);

    const second = getAcpSessionTokenKey({ dataDir });
    expect(second).toHaveLength(32);
    expect(second.equals(Buffer.alloc(32))).toBe(false);

    _resetForTests();
    expect(getAcpSessionTokenKey({ dataDir })).toEqual(second);
  });
});
