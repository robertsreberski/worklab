import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  coordinatorIncarnationDigest,
  coordinatorShutdownProof,
  ensureMcpToken,
} from "../../core/index.js";
import {
  readCoordinatorHealth,
  requestCoordinatorShutdown,
} from "../../cli/coordinator-control.js";
import { gracefulStopCoordinator } from "../../cli/service-drain.js";

describe("service drain helper", () => {
  const tempDirs = [];
  const locks = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const lock of locks.splice(0)) {
      try { if (lock.inTransaction) lock.exec("ROLLBACK"); } catch {}
      try { lock.close(); } catch {}
    }
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempDataDir() {
    const dir = mkdtempSync(join(tmpdir(), "worklab-service-drain-"));
    tempDirs.push(dir);
    return dir;
  }

  function holdLock(dataDir) {
    const lock = new Database(join(dataDir, ".coordinator.lock"), { timeout: 0 });
    lock.pragma("busy_timeout = 0");
    lock.exec("BEGIN EXCLUSIVE");
    locks.push(lock);
    return lock;
  }

  function releaseLock(lock) {
    const index = locks.indexOf(lock);
    if (index >= 0) locks.splice(index, 1);
    if (lock.inTransaction) lock.exec("ROLLBACK");
    lock.close();
  }

  function healthResponse(pid, incarnation) {
    return new Response(JSON.stringify({
      ok: true,
      pid,
      coordinator: {
        claim_format: "v2",
        incarnation_sha256: coordinatorIncarnationDigest(incarnation),
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }

  it("returns not_running when the coordinator pid file is absent", async () => {
    const result = await gracefulStopCoordinator({ config: { dataDir: tempDataDir() } });
    expect(result.status).toBe("not_running");
  });

  it("removes an invalid stale pid file", async () => {
    const dataDir = tempDataDir();
    const pidFile = join(dataDir, ".coordinator.pid");
    writeFileSync(pidFile, "not-a-pid\n");

    const result = await gracefulStopCoordinator({ config: { dataDir } });

    expect(result.status).toBe("stale_pid");
    expect(existsSync(pidFile)).toBe(false);
  });

  it("never signals a stale v2 PID when the lifetime lock is free", async () => {
    const dataDir = tempDataDir();
    const pidFile = join(dataDir, ".coordinator.pid");
    writeFileSync(pidFile, `${process.pid}\nv2:stale-reused-incarnation`);
    const kill = vi.spyOn(process, "kill");

    const result = await gracefulStopCoordinator({ config: { dataDir } });

    expect(result.status).toBe("stale_pid");
    expect(kill).not.toHaveBeenCalled();
    expect(existsSync(pidFile)).toBe(false);
  });

  it("requests exact-incarnation shutdown and times out on the lock without signaling a v2 PID", async () => {
    const dataDir = tempDataDir();
    const pidFile = join(dataDir, ".coordinator.pid");
    const pid = 12345;
    const incarnation = "drain-test-incarnation";
    const claim = `${pid}\nv2:${incarnation}`;
    writeFileSync(pidFile, claim);
    holdLock(dataDir);
    const kill = vi.spyOn(process, "kill");
    const fetchImpl = vi.fn(async (_url, options = {}) => {
      if (options.method === "GET") return healthResponse(pid, incarnation);
      expect(options.headers).toEqual({
        "x-worklab-coordinator-shutdown-proof": coordinatorShutdownProof(ensureMcpToken(dataDir), incarnation),
      });
      return new Response(null, { status: 202 });
    });

    const result = await gracefulStopCoordinator({
      config: { dataDir, host: "127.0.0.1", port: 7878, drainTimeoutMs: 0 },
      timeoutMs: 0,
      pollMs: 1,
      fetchImpl,
    });

    expect(result.status).toBe("timed_out");
    expect(readFileSync(pidFile, "utf8")).toBe(claim);
    expect(kill).not.toHaveBeenCalled();
  });

  it("bridges the lock-before-claim gap and shuts down only the published incarnation", async () => {
    const dataDir = tempDataDir();
    const pidFile = join(dataDir, ".coordinator.pid");
    const staleClaim = `${process.pid}\nv2:stale-gap-incarnation`;
    const currentPid = 23456;
    const currentIncarnation = "current-gap-incarnation";
    const currentClaim = `${currentPid}\nv2:${currentIncarnation}`;
    writeFileSync(pidFile, staleClaim);
    const lock = holdLock(dataDir);
    const kill = vi.spyOn(process, "kill");
    let healthReads = 0;
    const fetchImpl = vi.fn(async (_url, options = {}) => {
      if (options.method === "GET") {
        healthReads += 1;
        if (healthReads === 1) {
          writeFileSync(pidFile, currentClaim);
          return healthResponse(currentPid, currentIncarnation);
        }
        return healthResponse(currentPid, currentIncarnation);
      }
      expect(options.headers["x-worklab-coordinator-shutdown-proof"])
        .toBe(coordinatorShutdownProof(ensureMcpToken(dataDir), currentIncarnation));
      releaseLock(lock);
      return new Response(null, { status: 202 });
    });

    const result = await gracefulStopCoordinator({
      config: { dataDir, host: "127.0.0.1", port: 7878 },
      timeoutMs: 100,
      pollMs: 1,
      fetchImpl,
      controlRetryMs: 1,
    });

    expect(result.status).toBe("exited");
    expect(result.pid).toBe(currentPid);
    expect(kill).not.toHaveBeenCalled();
    expect(existsSync(pidFile)).toBe(false);
  });

  it("does not unlink a successor incarnation after the accepted shutdown", async () => {
    const dataDir = tempDataDir();
    const pidFile = join(dataDir, ".coordinator.pid");
    const initialPid = 12345;
    const initialIncarnation = "initial-incarnation";
    const initialClaim = `${initialPid}\nv2:${initialIncarnation}`;
    const replacementClaim = "54321\nv2:replacement-incarnation";
    writeFileSync(pidFile, initialClaim);
    const initialLock = holdLock(dataDir);
    let replacementLock;
    const fetchImpl = vi.fn(async (_url, options = {}) => {
      if (options.method === "GET") return healthResponse(initialPid, initialIncarnation);
      releaseLock(initialLock);
      replacementLock = holdLock(dataDir);
      writeFileSync(pidFile, replacementClaim);
      return new Response(null, { status: 202 });
    });

    const result = await gracefulStopCoordinator({
      config: { dataDir, host: "127.0.0.1", port: 7878 },
      timeoutMs: 100,
      pollMs: 1,
      fetchImpl,
    });

    expect(result.status).toBe("exited");
    expect(readFileSync(pidFile, "utf8")).toBe(replacementClaim);
    expect(replacementLock.inTransaction).toBe(true);
  });

  it("refuses an unverified busy claim without sending secrets or signals", async () => {
    const dataDir = tempDataDir();
    const claim = `${process.pid}\nv2:ambiguous-incarnation`;
    writeFileSync(join(dataDir, ".coordinator.pid"), claim);
    holdLock(dataDir);
    const kill = vi.spyOn(process, "kill");
    const fetchImpl = vi.fn(async () => healthResponse(99999, "different-incarnation"));

    const result = await gracefulStopCoordinator({
      config: { dataDir, host: "127.0.0.1", port: 7878 },
      fetchImpl,
      controlSettleMs: 0,
    });

    expect(result).toMatchObject({ status: "control_unavailable", reason: "identity_unconfirmed" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: "GET" });
    expect(kill).not.toHaveBeenCalled();
  });

  it("bounds a health response that sends headers but never finishes its JSON body", async () => {
    const dataDir = tempDataDir();
    writeFileSync(join(dataDir, ".coordinator.pid"), "34567\nv2:hanging-health-incarnation");
    holdLock(dataDir);
    const fetchImpl = vi.fn(async (_url, options = {}) => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"ok":true'));
          options.signal.addEventListener("abort", () => controller.error(options.signal.reason), { once: true });
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const startedAt = Date.now();
    const result = await gracefulStopCoordinator({
      config: { dataDir, host: "127.0.0.1", port: 7878 },
      fetchImpl,
      controlSettleMs: 0,
      controlRequestTimeoutMs: 20,
    });

    expect(result).toMatchObject({ status: "control_unavailable", reason: "identity_unconfirmed" });
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it("cancels endless status-only and rejected health response bodies", async () => {
    const dataDir = tempDataDir();
    let shutdownBodyCancelled = false;
    const shutdown = await requestCoordinatorShutdown({
      config: { dataDir, host: "127.0.0.1", port: 7878 },
      incarnation: "cancel-status-body-incarnation",
      fetchImpl: vi.fn(async () => new Response(new ReadableStream({
        cancel() { shutdownBodyCancelled = true; },
      }), { status: 202 })),
      timeoutMs: 20,
    });

    let healthBodyCancelled = false;
    const health = await readCoordinatorHealth({
      config: { dataDir, host: "127.0.0.1", port: 7878 },
      fetchImpl: vi.fn(async () => new Response(new ReadableStream({
        cancel() { healthBodyCancelled = true; },
      }), { status: 500, headers: { "content-type": "text/plain" } })),
      timeoutMs: 20,
    });

    expect(shutdown).toEqual({ status: "accepted" });
    expect(shutdownBodyCancelled).toBe(true);
    expect(health).toEqual({ status: "control_unavailable", health: null });
    expect(healthBodyCancelled).toBe(true);
  });
});
