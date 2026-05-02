import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getVapidKeys,
  sendWebPushNotification,
  vapidKeyPath,
  vapidPublicKey,
} from "../../core/web-push.js";

describe("web push keys", () => {
  const dirs = [];

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
  });

  function tempDataDir() {
    const dir = mkdtempSync(join(tmpdir(), "worklab-push-keys-"));
    dirs.push(dir);
    return dir;
  }

  it("creates and reuses local VAPID keys", async () => {
    const dataDir = tempDataDir();
    const webPush = {
      generateVAPIDKeys: vi.fn(() => ({ publicKey: "public", privateKey: "private" })),
    };

    expect(getVapidKeys({ dataDir, webPush })).toEqual({ publicKey: "public", privateKey: "private" });
    expect(getVapidKeys({ dataDir, webPush })).toEqual({ publicKey: "public", privateKey: "private" });
    expect(webPush.generateVAPIDKeys).toHaveBeenCalledTimes(1);
    expect(existsSync(vapidKeyPath(dataDir))).toBe(true);
    expect(statSync(vapidKeyPath(dataDir)).mode & 0o777).toBe(0o600);
    await expect(readFile(vapidKeyPath(dataDir), "utf8")).resolves.toContain("public");
    expect(vapidPublicKey({ dataDir, webPush })).toBe("public");
  });

  it("sends encrypted web push with VAPID details", async () => {
    const dataDir = tempDataDir();
    const subscription = { endpoint: "https://push.example/sub", keys: { p256dh: "key", auth: "auth" } };
    const payload = { title: "Run started", body: "Execute" };
    const webPush = {
      generateVAPIDKeys: vi.fn(() => ({ publicKey: "public", privateKey: "private" })),
      setVapidDetails: vi.fn(),
      sendNotification: vi.fn(async () => ({ statusCode: 201 })),
    };

    await expect(sendWebPushNotification({ dataDir, subscription, payload, webPush })).resolves.toEqual({ statusCode: 201 });
    expect(webPush.setVapidDetails).toHaveBeenCalledWith("mailto:worklab@localhost", "public", "private");
    expect(webPush.sendNotification).toHaveBeenCalledWith(subscription, JSON.stringify(payload));
  });
});
