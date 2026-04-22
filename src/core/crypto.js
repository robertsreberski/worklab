import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { loadConfig } from "./config.js";

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const HKDF_INFO = "worklab/provider-credentials/v1";
const KEY_FILE = ".provider-encryption-key";

let cached = null;

function decodeEnvKey(value) {
  if (/^[0-9a-fA-F]+$/.test(value) && value.length >= KEY_BYTES * 2) return Buffer.from(value, "hex");
  return Buffer.from(value, "base64");
}

function loadOrCreateMasterKey(dataDir) {
  const envKey = process.env.PROVIDER_ENCRYPTION_KEY?.trim();
  if (envKey) {
    const raw = decodeEnvKey(envKey);
    if (raw.length < KEY_BYTES) throw new Error(`PROVIDER_ENCRYPTION_KEY too short (${raw.length} bytes, need >= ${KEY_BYTES})`);
    return { raw, source: "env" };
  }

  const filePath = join(dataDir, KEY_FILE);
  if (existsSync(filePath)) {
    const raw = readFileSync(filePath);
    if (raw.length < KEY_BYTES) throw new Error(`provider encryption key file too short: ${filePath}`);
    return { raw, source: "file" };
  }

  const raw = randomBytes(KEY_BYTES);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, raw);
  try { chmodSync(filePath, 0o600); } catch { /* best-effort on non-POSIX */ }
  return { raw, source: "generated" };
}

function getDerivedKey(dataDir = loadConfig().dataDir) {
  const envKey = process.env.PROVIDER_ENCRYPTION_KEY?.trim() || "";
  const cacheKey = `${dataDir}:${envKey}`;
  if (cached?.cacheKey === cacheKey) return cached.key;
  const { raw, source } = loadOrCreateMasterKey(dataDir);
  const key = Buffer.from(hkdfSync("sha256", raw, Buffer.alloc(0), HKDF_INFO, KEY_BYTES));
  const fingerprint = createHash("sha256").update(key).digest("hex").slice(0, 12);
  cached = { cacheKey, key, source, fingerprint };
  return key;
}

export function getKeyFingerprint(options = {}) {
  getDerivedKey(options.dataDir);
  return cached.fingerprint;
}

export function getKeySource(options = {}) {
  getDerivedKey(options.dataDir);
  return cached.source;
}

export function encrypt(plaintext, options = {}) {
  if (typeof plaintext !== "string") throw new TypeError("encrypt: plaintext must be a string");
  const key = getDerivedKey(options.dataDir);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ciphertext, tag]).toString("base64");
}

export function decrypt(payload, options = {}) {
  if (!payload || typeof payload !== "string") throw new Error("decrypt: payload required");
  const raw = Buffer.from(payload, "base64");
  if (raw.length <= IV_BYTES + TAG_BYTES) throw new Error("decrypt: payload too short");
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(raw.length - TAG_BYTES);
  const ciphertext = raw.subarray(IV_BYTES, raw.length - TAG_BYTES);
  const decipher = createDecipheriv(ALGO, getDerivedKey(options.dataDir), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function _resetForTests() {
  cached = null;
}
