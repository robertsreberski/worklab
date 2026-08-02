const SECRET_FIELD_RE = /(?:password|passphrase|secret|token|api[_ -]?key|credential|authorization|cookie|private[_ -]?key|one[_ -]?time|\botp\b|\bpin\b|\bcvv\b|social[_ -]?security)/iu;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/u;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/gu;
const FIELD_TYPES = new Set(["string", "number", "integer", "boolean", "array"]);
const STRING_FORMATS = new Set(["email", "uri", "date", "date-time"]);

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(value, max = 2_000) {
  if (typeof value !== "string") return "";
  return value.replace(CONTROL_CHARS_RE, "").slice(0, max).trim();
}

function exactId(value, max = 512) {
  if (typeof value !== "string" || !value || value.length > max || CONTROL_CHAR_RE.test(value)) return "";
  return value;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function boundedInteger(value, { min = 0, max = 10_000 } = {}) {
  const number = finiteNumber(value);
  if (number == null) return null;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function stringChoices(schema = {}) {
  const choices = [];
  if (Array.isArray(schema.enum)) {
    for (const value of schema.enum) {
      if (typeof value !== "string") continue;
      choices.push({ value, label: text(value, 500) || value, description: "" });
    }
  }
  if (Array.isArray(schema.oneOf)) {
    for (const item of schema.oneOf) {
      if (!item || typeof item !== "object" || typeof item.const !== "string") continue;
      choices.push({
        value: item.const,
        label: text(item.title, 500) || item.const,
        description: text(item.description),
      });
    }
  }
  return [...new Map(choices.map((choice) => [choice.value, choice])).values()];
}

function arrayChoices(schema = {}) {
  const items = plainObject(schema.items);
  const source = Array.isArray(items.enum)
    ? items.enum.map((value) => ({ const: value, title: value }))
    : Array.isArray(items.anyOf) ? items.anyOf : [];
  const choices = source.flatMap((item) => {
    const value = typeof item === "string" ? item : item?.const;
    if (typeof value !== "string") return [];
    return [{
      value,
      label: text(item?.title, 500) || value,
      description: text(item?.description),
    }];
  });
  return [...new Map(choices.map((choice) => [choice.value, choice])).values()];
}

function isSecretField(key, schema) {
  return SECRET_FIELD_RE.test(`${key} ${schema?.title || ""} ${schema?.description || ""}`);
}

function normalizeFormFields(requestSchema = {}) {
  const schema = plainObject(requestSchema.requestedSchema);
  const formSchema = Object.keys(schema).length ? schema : requestSchema;
  const properties = plainObject(formSchema.properties);
  const required = new Set(Array.isArray(formSchema.required) ? formSchema.required.filter((key) => typeof key === "string") : []);
  const fields = [];
  const blockedFields = [];
  const unsupportedFields = [];

  for (const [key, value] of Object.entries(properties).slice(0, 100)) {
    const property = plainObject(value);
    const type = text(property.type, 32).toLowerCase();
    const label = text(property.title, 500) || key;
    if (isSecretField(key, property)) {
      blockedFields.push({ key, label, required: required.has(key) });
      continue;
    }
    if (!FIELD_TYPES.has(type)) {
      unsupportedFields.push({ key, label, required: required.has(key) });
      continue;
    }
    const choices = type === "array" ? arrayChoices(property) : stringChoices(property);
    if (type === "array" && choices.length === 0) {
      unsupportedFields.push({ key, label, required: required.has(key) });
      continue;
    }
    fields.push({
      key,
      label,
      description: text(property.description),
      type,
      required: required.has(key),
      format: STRING_FORMATS.has(property.format) ? property.format : "",
      choices,
      minLength: boundedInteger(property.minLength),
      maxLength: boundedInteger(property.maxLength, { max: 100_000 }),
      minimum: finiteNumber(property.minimum),
      maximum: finiteNumber(property.maximum),
      minItems: boundedInteger(property.minItems),
      maxItems: boundedInteger(property.maxItems, { max: 100 }),
    });
  }

  return {
    fields,
    blockedFields,
    unsupportedFields,
    title: text(formSchema.title, 500),
    description: text(formSchema.description),
  };
}

function permissionOptions(requestSchema = {}) {
  const source = Array.isArray(requestSchema.options) ? requestSchema.options : [];
  const options = source.flatMap((raw) => {
    const option = plainObject(raw);
    const id = exactId(option.optionId ?? option.id);
    if (!id) return [];
    return [{
      id,
      label: text(option.name ?? option.label, 500) || id,
      kind: text(option.kind, 64).toLowerCase(),
    }];
  });
  return [...new Map(options.map((option) => [option.id, option])).values()];
}

function safeInteractionUrl(value) {
  const raw = text(value, 8_192);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, "[redacted]");
    return url.toString();
  } catch {
    return "";
  }
}

export function normalizeAcpInteraction(interaction = {}) {
  const id = exactId(interaction.id, 1_000);
  const kind = ["permission", "form", "url"].includes(interaction.kind) ? interaction.kind : "unknown";
  const requestSchema = plainObject(interaction.requestSchema ?? interaction.request_schema);
  const form = kind === "form" ? normalizeFormFields(requestSchema) : {
    fields: [], blockedFields: [], unsupportedFields: [], title: "", description: "",
  };
  const toolCall = plainObject(requestSchema.toolCall);
  const createdAt = finiteNumber(interaction.createdAt ?? interaction.created_at);
  return {
    id,
    kind,
    state: text(interaction.state, 32).toLowerCase(),
    profileId: exactId(interaction.profileId ?? interaction.profile_id, 1_000),
    taskRunId: exactId(interaction.taskRunId ?? interaction.task_run_id, 1_000),
    operationId: exactId(interaction.operationId ?? interaction.operation_id, 1_000),
    protocolRequestId: exactId(interaction.protocolRequestId ?? interaction.protocol_request_id, 1_000),
    createdAt,
    title: form.title || text(requestSchema.title, 500),
    message: text(requestSchema.message ?? requestSchema.description ?? form.description),
    toolCall: kind === "permission" ? {
      title: text(toolCall.title, 500),
      kind: text(toolCall.kind, 128),
      status: text(toolCall.status, 128),
    } : null,
    options: kind === "permission" ? permissionOptions(requestSchema) : [],
    fields: form.fields,
    blockedFields: form.blockedFields,
    unsupportedFields: form.unsupportedFields,
    url: kind === "url" ? safeInteractionUrl(requestSchema.url) : "",
  };
}

export function normalizePendingAcpInteractions(response = {}) {
  const source = Array.isArray(response) ? response : response.interactions;
  if (!Array.isArray(source)) return [];
  return source
    .map(normalizeAcpInteraction)
    .filter((interaction) => interaction.id && interaction.kind !== "unknown" && interaction.state === "pending")
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || a.id.localeCompare(b.id));
}

export function acpInteractionEventRequiresRefresh(event = {}) {
  const type = text(event.type, 128).toLowerCase();
  if (type === "worklab_stream_connected") return true;
  if (type.startsWith("acp_interaction_")) return true;
  if (type !== "run_progress") return false;
  return text(event.lastEvent?.type ?? event.last_event?.type, 128).toLowerCase().startsWith("acp_interaction_");
}

export function acpInteractionIsReconnectEvent(event = {}) {
  return text(event.type, 128).toLowerCase() === "worklab_stream_connected";
}

export function acpInteractionCanAutoOpen(documentLike = globalThis.document) {
  return !documentLike?.querySelector?.('[role="dialog"][aria-modal="true"]');
}

export function acpPermissionResponse(interaction, optionId) {
  const exactOptionId = exactId(optionId);
  if (!exactOptionId || !interaction?.options?.some((option) => option.id === exactOptionId)) {
    throw new Error("Choose one of the offered permission options.");
  }
  return {
    disposition: "selected",
    outcome: { outcome: "selected", optionId: exactOptionId },
  };
}

export function acpFormInitialValues(interaction) {
  return Object.fromEntries((interaction?.fields || []).map((field) => {
    if (field.type === "boolean") return [field.key, false];
    if (field.type === "array") return [field.key, []];
    return [field.key, ""];
  }));
}

export function acpFormValues(interaction, draft = {}) {
  const values = {};
  const errors = {};
  for (const field of interaction?.fields || []) {
    const raw = draft[field.key];
    if (field.type === "boolean") {
      values[field.key] = raw === true;
      continue;
    }
    if (field.type === "array") {
      const allowed = new Set(field.choices.map((choice) => choice.value));
      const selected = Array.isArray(raw) ? [...new Set(raw.filter((value) => allowed.has(value)))] : [];
      if (field.required && selected.length === 0) errors[field.key] = "Select at least one option.";
      if (field.minItems != null && selected.length < field.minItems) errors[field.key] = `Select at least ${field.minItems}.`;
      if (field.maxItems != null && selected.length > field.maxItems) errors[field.key] = `Select no more than ${field.maxItems}.`;
      if (selected.length > 0 || field.required) values[field.key] = selected;
      continue;
    }
    const rawText = typeof raw === "string" ? raw : raw == null ? "" : String(raw);
    if (!rawText && field.required) {
      errors[field.key] = "This field is required.";
      continue;
    }
    if (!rawText) continue;
    if (field.type === "number" || field.type === "integer") {
      const number = Number(rawText);
      if (!Number.isFinite(number) || (field.type === "integer" && !Number.isInteger(number))) {
        errors[field.key] = field.type === "integer" ? "Enter a whole number." : "Enter a number.";
        continue;
      }
      if (field.minimum != null && number < field.minimum) errors[field.key] = `Enter ${field.minimum} or more.`;
      if (field.maximum != null && number > field.maximum) errors[field.key] = `Enter ${field.maximum} or less.`;
      values[field.key] = number;
      continue;
    }
    if (field.choices.length > 0 && !field.choices.some((choice) => choice.value === rawText)) {
      errors[field.key] = "Choose one of the offered values.";
      continue;
    }
    if (field.minLength != null && rawText.length < field.minLength) errors[field.key] = `Enter at least ${field.minLength} characters.`;
    if (field.maxLength != null && rawText.length > field.maxLength) errors[field.key] = `Enter no more than ${field.maxLength} characters.`;
    values[field.key] = rawText;
  }
  for (const field of [...(interaction?.blockedFields || []), ...(interaction?.unsupportedFields || [])]) {
    if (field.required) errors[field.key] = "This required field cannot be collected safely in Worklab.";
  }
  return { values, errors };
}

export function acpFormResponse(interaction, draft = {}) {
  const { values, errors } = acpFormValues(interaction, draft);
  if (Object.keys(errors).length > 0) {
    throw Object.assign(new Error("Complete the required form fields."), { fieldErrors: errors });
  }
  return { disposition: "accept", action: "accept", content: values };
}

export function acpElicitationDecision(disposition) {
  if (disposition !== "accept" && disposition !== "decline") throw new Error("Invalid elicitation decision.");
  return { disposition, action: disposition };
}

export function acpInteractionIsStale(error) {
  return Number(error?.status) === 409
    || ["not_pending", "no_pending_interaction", "not_active", "operation_ended"].includes(String(error?.code || "").toLowerCase());
}
