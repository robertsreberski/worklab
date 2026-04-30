const RUN_PREVIEW_METADATA_FIELDS = [
  ["Task", ["task_key", "task_id"]],
  ["Project", ["project_name", "project_slug", "project_id"]],
  ["Project context", ["project_context_hash"]],
  ["Workdir", ["workdir"]],
  ["Stage", ["stage"]],
  ["Mode", ["mode"]],
  ["Agent", ["agent_name"]],
  ["Model", ["model"]],
  ["Effort", ["effort"]],
];

function pickMetadataValue(metadata, keys) {
  for (const key of keys) {
    const value = metadata?.[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

export function normalizeRunPreviewInput(preview) {
  const input = preview?.input || {};
  const metadata = {
    task_id: input.metadata?.task_id ?? preview?.task_id ?? null,
    task_key: input.metadata?.task_key ?? preview?.task_key ?? null,
    stage: input.metadata?.stage ?? preview?.stage ?? null,
    mode: input.metadata?.mode ?? preview?.mode ?? null,
    project_id: input.metadata?.project_id ?? preview?.project_id ?? null,
    project_slug: input.metadata?.project_slug ?? preview?.project_slug ?? null,
    project_name: input.metadata?.project_name ?? preview?.project_name ?? null,
    project_context_hash: input.metadata?.project_context_hash ?? preview?.project_context_hash ?? null,
    workdir: input.metadata?.workdir ?? preview?.workdir ?? null,
    agent_name: input.metadata?.agent_name ?? preview?.agent_name ?? null,
    model: input.metadata?.model ?? preview?.model ?? null,
    effort: input.metadata?.effort ?? preview?.effort ?? null,
    generated_at: input.metadata?.generated_at ?? preview?.generated_at ?? null,
  };
  const system = {
    format: input.system?.format || "markdown",
    content: input.system?.content ?? preview?.system_prompt ?? "",
  };
  const sourceMessages = Array.isArray(input.messages)
    ? input.messages
    : (Array.isArray(preview?.messages) ? preview.messages : []);
  const messages = sourceMessages.map((message) => ({
    role: message?.role || "user",
    format: message?.format || "markdown",
    content: message?.content ?? "",
  }));
  const tools = Array.isArray(input.tools) ? input.tools.filter((tool) => tool?.name) : [];
  return { metadata, system, messages, tools };
}

export function runPreviewMetadataItems(metadata) {
  return RUN_PREVIEW_METADATA_FIELDS
    .map(([label, keys]) => [label, pickMetadataValue(metadata, keys)])
    .filter(([, value]) => value);
}

function codeFence(format, content) {
  const lang = format === "json" ? "json" : (format === "markdown" ? "markdown" : "");
  return [`\`\`\`${lang}`, content || "", "```"].join("\n");
}

function formatMessageForCopy(message, index) {
  return [
    `### ${message.role || "message"} message ${index + 1}`,
    `- Format: ${message.format || "plain"}`,
    "",
    codeFence(message.format, message.content),
  ].join("\n");
}

export function formatRunPreviewForCopy(preview) {
  if (!preview) return "";
  const input = normalizeRunPreviewInput(preview);
  const meta = runPreviewMetadataItems(input.metadata)
    .map(([label, value]) => `- ${label}: ${value}`);
  const messages = input.messages.length
    ? input.messages.map(formatMessageForCopy).join("\n\n")
    : "_No user messages._";
  const tools = input.tools.map((tool) => {
    const purpose = tool.purpose ? `: ${tool.purpose}` : "";
    return `- \`${tool.name}\`${purpose}`;
  });
  return [
    "# Run input",
    "## Metadata",
    meta.join("\n"),
    "## System message",
    `- Format: ${input.system.format || "plain"}`,
    "",
    codeFence(input.system.format, input.system.content),
    "## User messages",
    messages,
    tools.length ? "## On-demand tools" : "",
    tools.join("\n"),
  ].filter(Boolean).join("\n\n");
}
