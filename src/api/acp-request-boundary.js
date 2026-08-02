import { isIP } from "node:net";

import { ensureMcpToken, tokenMatches } from "../core/index.js";

const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);
const ACTIVE_READ_PATHS = new Set(["/acp/discovery/mono"]);

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

function sameUiBoundary(req, { origins, hosts }) {
  const target = requestUrl(req);
  if (!target || !trustedRequestHost(target.hostname, hosts)) return false;
  if (String(req.get("sec-fetch-site") || "").toLowerCase() === "cross-site") return false;

  const source = browserSourceUrl(req);
  if (!source) return false;
  if (origins.has(source.origin)) return true;
  if (source.protocol === target.protocol
    && loopbackHostname(source.hostname)
    && loopbackHostname(target.hostname)) return true;
  return source.origin === target.origin;
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
    const activeRead = new Set(["GET", "HEAD"]).has(req.method)
      && ACTIVE_READ_PATHS.has(req.path);
    if (req.method === "OPTIONS" || (!activeRead && new Set(["GET", "HEAD"]).has(req.method))) {
      next();
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
