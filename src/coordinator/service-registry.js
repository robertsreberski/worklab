const DEFAULT_OPTIONAL_SERVICE_START_TIMEOUT_MS = 5000;

function optionalServiceStatus(service, reason) {
  const base = service?.status?.() || {};
  return {
    ...base,
    enabled: base.enabled !== false,
    connected: false,
    reason,
  };
}

export function startDeferredService({
  name,
  service,
  startTimeoutMs = DEFAULT_OPTIONAL_SERVICE_START_TIMEOUT_MS,
  logger,
} = {}) {
  let override = optionalServiceStatus(service, "starting");
  let timer = null;
  let settled = false;

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  let startPromise;
  try {
    startPromise = service?.start?.({ timeoutMs: startTimeoutMs });
  } catch (err) {
    startPromise = Promise.reject(err);
  }

  Promise.resolve(startPromise)
    .then(() => {
      if (settled) return;
      settled = true;
      clear();
      override = null;
    })
    .catch((err) => {
      if (settled) return;
      settled = true;
      clear();
      override = optionalServiceStatus(service, "start_failed");
      logger?.warn?.({ err, service: name }, "optional service failed to start");
    });

  if (Number.isFinite(Number(startTimeoutMs)) && Number(startTimeoutMs) > 0) {
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      override = optionalServiceStatus(service, "start_timeout");
      logger?.warn?.({ service: name, timeout_ms: Number(startTimeoutMs) }, "optional service start timed out");
      service?.stop?.("start_timeout");
    }, Number(startTimeoutMs));
    timer.unref?.();
  }

  const wrapped = service ? Object.assign(Object.create(Object.getPrototypeOf(service)), service) : {};
  wrapped.status = (...args) => override || service?.status?.(...args);
  wrapped.shutdown = async (...args) => {
    clear();
    settled = true;
    if (typeof service?.shutdown === "function") return service.shutdown(...args);
    if (typeof service?.stop === "function") return service.stop("shutdown");
    return undefined;
  };
  return wrapped;
}

export function createBackgroundServiceRegistry({ logger, markStartup } = {}) {
  const entries = [];

  function register(entry = {}) {
    entries.push(entry);
    return entry;
  }

  function startAll() {
    for (const entry of entries) {
      try {
        entry.start?.();
      } catch (err) {
        logger?.warn?.({ err, service: entry.name }, "background service start error");
      }
      markStartup?.(entry.phase || `${entry.name}_start`);
    }
  }

  async function shutdownAll() {
    for (const entry of entries) {
      try {
        if (typeof entry.shutdown === "function") {
          await entry.shutdown();
        } else if (typeof entry.stop === "function") {
          await entry.stop();
        }
      } catch (err) {
        logger?.warn?.({ err, service: entry.name }, "background service shutdown error");
      }
    }
  }

  function status() {
    return Object.fromEntries(entries.map((entry) => [
      entry.name,
      entry.status?.() || { enabled: true },
    ]));
  }

  return {
    register,
    startAll,
    shutdownAll,
    status,
  };
}
