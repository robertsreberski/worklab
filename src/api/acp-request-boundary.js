import { isIP } from "node:net";

import { ensureMcpToken, tokenMatches } from "../core/index.js";

const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);
const ACTIVE_READ_PATHS = new Set([
  "/acp/discovery/mono",
  "/assistant",
  "/assistant/messages",
  "/models/available",
  "/models/opencode",
  "/notifications/status",
  "/search",
  "/search/embedding-test",
  "/settings/runtime",
  "/update",
]);
const ACTIVE_READ_PATH_PATTERNS = Object.freeze([
  /^\/goals(?:\/[^/]+)?$/u,
  /^\/projects\/[^/]+$/u,
  /^\/runs\/(?!cost-summary$)[^/]+$/u,
  /^\/tasks\/[^/]+$/u,
  /^\/tasks\/[^/]+\/run-preview$/u,
  /^\/teams\/[^/]+(?:\/goals)?$/u,
]);
const TASK_RUN_HISTORY_PATH = /^\/tasks\/[^/]+\/runs$/u;
const TASK_SCOPED_FILE_PATHS = new Set(["/files/read", "/files/suggest"]);
const CORS_METHODS = "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS";
const CORS_HEADERS = "Authorization, Content-Type, Last-Event-ID, X-Attachment-Filename, X-Skill-Filename";
const ACP_URL_OPEN_PATH = /^\/acp\/interactions\/[^/]+\/url:open$/iu;

function bearerToken(req) {
  const value = req.get("authorization") || "";
  const match = /^Bearer\s+(.+)$/iu.exec(value);
  return match ? match[1].trim() : "";
}

function normalizedHostname(value) {
  if (typeof value !== "string" || value.length === 0) return "";
  const hostname = value.toLowerCase();
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function loopbackHostname(value) {
  const hostname = normalizedHostname(value);
  if (hostname === "localhost" || hostname === "::1") return true;
  return isIP(hostname) === 4 && hostname.startsWith("127.");
}

function parsedHttpUrl(value) {
  if (typeof value !== "string" || value.trim().length === 0 || value === "null") return null;
  try {
    const url = new URL(value);
    if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

function requestUrl(req) {
  const host = req.get("host");
  if (!host || /[\u0000-\u001f\u007f]/u.test(host)) return null;
  const forwarded = String(req.get("x-forwarded-proto") || "").split(",")[0].trim().toLowerCase();
  const protocol = new Set(["http", "https"]).has(forwarded) ? forwarded : req.protocol;
  return parsedHttpUrl(`${protocol}://${host}`);
}

function configuredOrigins(env) {
  const result = new Set();
  for (const value of String(env?.WORKLAB_ACP_ALLOWED_ORIGINS || "").split(",")) {
    const url = parsedHttpUrl(value.trim());
    if (url) result.add(url.origin);
  }
  return result;
}

function configuredHosts(config, origins) {
  const hosts = new Set([...origins].map((origin) => normalizedHostname(new URL(origin).hostname)));
  const configured = normalizedHostname(config?.host);
  if (configured && !WILDCARD_HOSTS.has(configured)) hosts.add(configured);
  return hosts;
}

function trustedRequestHost(hostname, hosts) {
  const normalized = normalizedHostname(hostname);
  return loopbackHostname(normalized)
    || normalized.endsWith(".ts.net")
    || hosts.has(normalized);
}

function browserSourceUrl(req) {
  return parsedHttpUrl(req.get("origin")) || parsedHttpUrl(req.get("referer"));
}

function configuredCorsOrigin(req, { origins, hosts }) {
  const source = parsedHttpUrl(req.get("origin"));
  const target = requestUrl(req);
  if (!source || !target || !origins.has(source.origin) || !trustedRequestHost(target.hostname, hosts)) {
    return null;
  }
  return source.origin;
}

function setConfiguredCorsHeaders(res, origin, { preflight = false } = {}) {
  res.vary("Origin");
  res.set("Access-Control-Allow-Origin", origin);
  if (!preflight) return;
  res.vary("Access-Control-Request-Method");
  res.vary("Access-Control-Request-Headers");
  res.set("Access-Control-Allow-Methods", CORS_METHODS);
  res.set("Access-Control-Allow-Headers", CORS_HEADERS);
  res.set("Access-Control-Max-Age", "600");
}

function sameUiBoundary(req, { origins, hosts }) {
  const target = requestUrl(req);
  if (!target || !trustedRequestHost(target.hostname, hosts)) return false;

  const source = browserSourceUrl(req);
  if (!source) return false;
  if (origins.has(source.origin)) return true;
  if (String(req.get("sec-fetch-site") || "").toLowerCase() === "cross-site") return false;
  return source.origin === target.origin;
}

function normalizedRequestPath(req) {
  const path = req.path.length > 1 ? req.path.replace(/\/+$/u, "") : req.path;
  return path.toLowerCase();
}

function decodedRequestPath(req) {
  const path = normalizedRequestPath(req);
  try {
    return decodeURIComponent(path);
  } catch {
    return "";
  }
}

function activeReadRequest(req, decodedPath, rawPath) {
  if (ACTIVE_READ_PATHS.has(decodedPath)
    // Match dynamic route segments before decoding so an encoded slash stays
    // inside the same Express parameter instead of bypassing the path shape.
    || ACTIVE_READ_PATH_PATTERNS.some((pattern) => pattern.test(rawPath))) {
    return true;
  }
  if (TASK_RUN_HISTORY_PATH.test(rawPath)) {
    const requestedView = req.query?.view;
    const view = requestedView == null || requestedView === "" ? "full" : String(requestedView);
    return view === "full";
  }
  if (TASK_SCOPED_FILE_PATHS.has(decodedPath)) {
    return String(req.query?.task_id || req.query?.task || "").trim().length > 0;
  }
  return false;
}

/**
 * Worklab mutations can schedule tool-capable local agents and ACP processes.
 * Keep those actions unavailable to arbitrary websites: browser UI calls must
 * carry an exact trusted Origin/Referer, while automation clients can use the
 * existing local service token. This is a CSRF/browser-origin boundary, not a
 * replacement for network access control on the bound Worklab host.
 */
export function createApiMutationBoundary({
  dataDir,
  config,
  env = process.env,
} = {}) {
  const origins = configuredOrigins(env);
  const hosts = configuredHosts(config, origins);
  const expectedToken = dataDir ? ensureMcpToken(dataDir) : "";

  return (req, res, next) => {
    const corsOrigin = configuredCorsOrigin(req, { origins, hosts });
    if (corsOrigin) setConfiguredCorsHeaders(res, corsOrigin);

    const rawRequestPath = normalizedRequestPath(req);
    const requestPath = decodedRequestPath(req);
    const activeRead = new Set(["GET", "HEAD"]).has(req.method)
      && activeReadRequest(req, requestPath, rawRequestPath);
    if (req.method === "OPTIONS") {
      if (!req.get("origin")) {
        next();
        return;
      }
      if (corsOrigin) {
        setConfiguredCorsHeaders(res, corsOrigin, { preflight: true });
        res.status(204).end();
        return;
      }
      res.status(403).json({
        error: {
          code: "forbidden_origin",
          message: "Browser API access must come from an explicitly configured Worklab UI origin",
        },
      });
      return;
    }
    if (!activeRead && new Set(["GET", "HEAD"]).has(req.method)) {
      next();
      return;
    }
    if (req.method === "POST" && ACP_URL_OPEN_PATH.test(requestPath)) {
      if (sameUiBoundary(req, { origins, hosts })) {
        next();
        return;
      }
      res.status(403).json({
        error: {
          code: "forbidden_origin",
          message: "ACP URL handoffs must be opened from the Worklab browser UI",
        },
      });
      return;
    }
    if (expectedToken && tokenMatches(bearerToken(req), expectedToken)) {
      next();
      return;
    }
    if (sameUiBoundary(req, { origins, hosts })) {
      next();
      return;
    }

    const browserContext = Boolean(req.get("origin") || req.get("referer"));
    res.status(browserContext ? 403 : 401).json({
      error: {
        code: browserContext ? "forbidden_origin" : "unauthorized",
        message: "Process-starting and state-changing API requests must come from the Worklab UI or use the local service token",
      },
    });
  };
}
