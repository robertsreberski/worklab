export function safeParseJson(value) {
  if (typeof value !== "string") return { ok: false, value: null };
  const raw = value.trim();
  if (!raw) return { ok: false, value: null };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, value: null };
  }
}

export function parseMaybeJson(value) {
  if (typeof value !== "string") return { value, parsed: false };
  const parsed = safeParseJson(value);
  return parsed.ok ? { value: parsed.value, parsed: true } : { value, parsed: false };
}

export function rawJsonText(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value ?? "");
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function worklabValue(value) {
  if (value?.schema === "worklab.v2") return value;
  if (value?.worklab_result?.schema === "worklab.v2") return value.worklab_result;
  return null;
}

function errorValue(value) {
  if (!isObject(value)) return null;
  for (const key of ["message", "error"]) {
    if (typeof value[key] === "string") {
      const parsed = safeParseJson(value[key]);
      if (parsed.ok) {
        const nested = errorValue(parsed.value);
        if (nested) return nested;
      }
    }
  }
  if (isObject(value.error)) {
    for (const key of ["message", "error"]) {
      if (typeof value.error[key] === "string") {
        const parsed = safeParseJson(value.error[key]);
        if (parsed.ok) {
          const nested = errorValue(parsed.value);
          if (nested) return nested;
        }
      }
    }
  }
  const err = isObject(value.error) ? value.error : value;
  if (
    err.code ||
    err.message ||
    err.param ||
    err.status ||
    value.status ||
    value.type === "error" ||
    /(?:error|fail)/i.test(String(value.type || ""))
  ) {
    return isObject(value.error) ? { ...err, status: err.status ?? value.status } : err;
  }
  return null;
}

export function structuredErrorValue(input) {
  const { value } = parseMaybeJson(input);
  return errorValue(value);
}

function isJsonSchema(value) {
  return isObject(value) && (
    value.$schema ||
    value.properties ||
    value.required ||
    value.additionalProperties !== undefined ||
    (typeof value.type === "string" && ["object", "array", "string", "number", "integer", "boolean", "null"].includes(value.type))
  );
}

function contentArray(value) {
  if (Array.isArray(value) && value.some((item) => isObject(item) && item.type && ("text" in item || "content" in item))) return value;
  if (Array.isArray(value?.content)) return value.content;
  return null;
}

export function structuredKind(input) {
  const { value } = parseMaybeJson(input);
  if (worklabValue(value)) return "worklab";
  if (errorValue(value)) return "error";
  if (contentArray(value)) return "content";
  if (isJsonSchema(value)) return "schema";
  if (Array.isArray(value)) return "array";
  if (isObject(value)) return "object";
  return "text";
}

export function structuredPreview(input) {
  const { value } = parseMaybeJson(input);
  const worklab = worklabValue(value);
  if (worklab) return worklab.summary || `${worklab.stage || "worklab"} ${worklab.decision || "result"}`.trim();

  const error = errorValue(value);
  if (error) return [error.code, error.param, error.message].filter(Boolean).join(" · ") || "Error";

  const content = contentArray(value);
  if (content) {
    const firstText = content.map((item) => item.text || item.content).filter(Boolean)[0];
    return firstText ? String(firstText).replace(/\s+/g, " ").slice(0, 180) : `${content.length} content item${content.length === 1 ? "" : "s"}`;
  }

  if (isJsonSchema(value)) {
    const type = Array.isArray(value.type) ? value.type.join(" | ") : (value.type || "schema");
    const count = Object.keys(value.properties || {}).length;
    return `JSON Schema: ${type}${count ? `, ${count} propert${count === 1 ? "y" : "ies"}` : ""}`;
  }

  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  if (isObject(value)) return `${Object.keys(value).length} field${Object.keys(value).length === 1 ? "" : "s"}`;
  return String(value ?? "");
}

export function schemaPropertyRows(schema = {}) {
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.entries(schema.properties || {}).map(([name, prop]) => ({
    name,
    type: Array.isArray(prop?.type) ? prop.type.join(" | ") : (prop?.type || (prop?.enum ? "enum" : prop?.anyOf ? "anyOf" : "value")),
    required: required.has(name),
    enum: Array.isArray(prop?.enum) ? prop.enum.join(", ") : "",
  }));
}

export function splitStructuredText(text) {
  const raw = String(text || "");
  const trimmed = raw.trim();
  if (!trimmed) return [];

  const prefixedError = /^ERROR:\s*({[\s\S]*})\s*$/.exec(trimmed);
  if (prefixedError) {
    const parsed = safeParseJson(prefixedError[1]);
    if (parsed.ok) return [{ type: "markdown", text: "ERROR:" }, { type: "structured", value: parsed.value }];
  }

  const whole = safeParseJson(trimmed);
  if (whole.ok) return [{ type: "structured", value: whole.value }];

  const segments = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  let lastIndex = 0;
  let match;
  while ((match = fence.exec(raw))) {
    const before = raw.slice(lastIndex, match.index);
    if (before.trim()) segments.push({ type: "markdown", text: before.trim() });
    const parsed = safeParseJson(match[1]);
    if (parsed.ok) segments.push({ type: "structured", value: parsed.value });
    else segments.push({ type: "markdown", text: match[0] });
    lastIndex = fence.lastIndex;
  }
  const tail = raw.slice(lastIndex);
  if (tail.trim()) segments.push({ type: "markdown", text: tail.trim() });
  return segments.length ? segments : [{ type: "markdown", text: raw }];
}
