import { useCallback, useEffect, useState } from "preact/hooks";
import { api } from "../../lib/api.js";

const RESTART_POLL_INTERVAL_MS = 1000;
const RESTART_POLL_MAX_ATTEMPTS = 90;

export function latestUpdateVersion(status) {
  return status?.package?.latest_version || "";
}

export function currentUpdateVersion(status) {
  return status?.package?.current_version || "";
}

export function updateStateForBadge(status, { busy = false, error = null } = {}) {
  if (error) return "error";
  if (busy && !status) return "checking";
  if (!status) return "unknown";
  if (status.update_available) return "available";
  if (status.status === "current") return "current";
  if (status.status === "local_newer") return "newer";
  return "unknown";
}

export function updateStateLabel(status, { busy = false, error = null } = {}) {
  const state = updateStateForBadge(status, { busy, error });
  switch (state) {
    case "available": return "Update available";
    case "current": return "Up to date";
    case "newer": return "Local newer than npm";
    case "checking": return "Checking…";
    case "error": return "Check failed";
    default: return "Unknown";
  }
}

export function updateInstallExplanation(install) {
  if (!install) return "";
  if (install.supported) return "";
  switch (install.reason) {
    case "source_checkout":
      return "Worklab is running from a source checkout. One-click updates require a global npm install.";
    case "npm_cli_not_found":
      return "The npm CLI bundled with this Node runtime was not found, so Worklab cannot self-update.";
    case "npm_root_unavailable":
    case "npm_root_failed":
      return "Worklab could not determine the global npm install location. Run `npm root -g` to debug.";
    case "package_root_mismatch":
      return "Worklab is running from inside the global npm root but the package path does not match. The install may be inconsistent.";
    case "not_global_npm_package":
      return "Worklab is not running from the global npm package install. One-click updates require `npm install -g worklab`.";
    case "repo_root_missing":
      return "Worklab could not resolve its install location.";
    default:
      return "One-click updates are not available for this install.";
  }
}

export function updateInstallCommand(install, status) {
  const latest = latestUpdateVersion(status);
  if (!latest) return "";
  const pkg = status?.package?.name || "worklab";
  return `npm install -g ${pkg}@${latest}`;
}

export function useUpdateStatus({ autoLoad = true } = {}) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [applying, setApplying] = useState(false);

  const load = useCallback(async ({ refresh = false, signal } = {}) => {
    setBusy(true);
    setError(null);
    try {
      const response = await api.getUpdate(refresh ? { refresh: "1" } : undefined, signal ? { signal } : undefined);
      if (signal?.aborted) return null;
      setStatus(response.update || null);
      return response.update || null;
    } catch (err) {
      if (err?.name === "AbortError") return null;
      setError(err.message || "Update check failed");
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!autoLoad) return undefined;
    const controller = new AbortController();
    load({ signal: controller.signal }).catch(() => {});
    return () => controller.abort();
  }, [autoLoad, load]);

  const pollForRestart = useCallback((targetVersion, attempts = 0) => {
    window.setTimeout(async () => {
      try {
        const health = await api.getHealth();
        if (health?.package?.version === targetVersion) {
          window.location.reload();
          return;
        }
      } catch {}
      if (attempts < RESTART_POLL_MAX_ATTEMPTS) {
        pollForRestart(targetVersion, attempts + 1);
      } else {
        setApplying(false);
      }
    }, RESTART_POLL_INTERVAL_MS);
  }, []);

  const apply = useCallback(async () => {
    const latest = latestUpdateVersion(status);
    if (!latest) return null;
    setApplying(true);
    setError(null);
    try {
      const response = await api.applyUpdate(latest);
      if (response?.update) {
        setStatus({ ...response.update, job: response.apply });
      }
      pollForRestart(latest);
      return response;
    } catch (err) {
      setApplying(false);
      setError(err.message || "Update failed");
      throw err;
    }
  }, [status, pollForRestart]);

  return { status, setStatus, busy, applying, error, refresh: load, apply };
}
