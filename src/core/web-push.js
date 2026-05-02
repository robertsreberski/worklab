import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import webPushDefault from "web-push";

const VAPID_FILE = "push-vapid.json";
const DEFAULT_SUBJECT = "mailto:worklab@localhost";

export function vapidKeyPath(dataDir) {
  if (!dataDir) throw new Error("dataDir is required");
  return join(dataDir, VAPID_FILE);
}

function validKeys(value) {
  return value
    && typeof value.publicKey === "string"
    && value.publicKey
    && typeof value.privateKey === "string"
    && value.privateKey;
}

function readKeys(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (validKeys(parsed)) return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
  } catch {
    return null;
  }
  return null;
}

export function getVapidKeys({ dataDir, webPush = webPushDefault } = {}) {
  const path = vapidKeyPath(dataDir);
  if (existsSync(path)) {
    const existing = readKeys(path);
    if (existing) return existing;
  }
  const keys = webPush.generateVAPIDKeys();
  if (!validKeys(keys)) throw new Error("failed to generate VAPID keys");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ publicKey: keys.publicKey, privateKey: keys.privateKey }, null, 2)}\n`, { mode: 0o600 });
  return { publicKey: keys.publicKey, privateKey: keys.privateKey };
}

export function vapidPublicKey({ dataDir, webPush = webPushDefault } = {}) {
  return getVapidKeys({ dataDir, webPush }).publicKey;
}

export async function sendWebPushNotification({
  dataDir,
  subscription,
  payload,
  subject = DEFAULT_SUBJECT,
  webPush = webPushDefault,
} = {}) {
  const keys = getVapidKeys({ dataDir, webPush });
  webPush.setVapidDetails(subject, keys.publicKey, keys.privateKey);
  return webPush.sendNotification(subscription, JSON.stringify(payload));
}
