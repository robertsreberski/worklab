import { Icon } from "./Icon.jsx";
import { IconButton } from "./primitives/IconButton.jsx";

function attachmentKey(attachment, index) {
  return attachment.id || attachment.upload_id || attachment.client_id || `${attachment.kind}-${index}`;
}

function attachmentTitle(attachment) {
  if (attachment.kind === "path") return attachment.label || attachment.path_text || attachment.path || "Path";
  return attachment.label || attachment.filename || "Attachment";
}

function attachmentMeta(attachment) {
  if (attachment.kind === "path") return attachment.path_text || attachment.path || attachment.absolute_path || "";
  const parts = [
    attachment.filename,
    attachment.mime_type,
    attachment.size_bytes != null ? `${attachment.size_bytes} bytes` : "",
  ].filter(Boolean);
  return parts.join(" - ");
}

export function AttachmentChips({
  attachments = [],
  onChange,
  disabled = false,
  uploading = false,
  uploadError = "",
  class: className = "",
}) {
  const hasContent = attachments.length > 0 || uploading || uploadError;
  if (!hasContent) return null;

  function removeAttachment(index) {
    if (disabled) return;
    onChange?.(attachments.filter((_, i) => i !== index));
  }

  return (
    <div class={`attachment-tray ${className}`.trim()}>
      <div class="attachment-chip-row">
        {attachments.map((attachment, index) => (
          <span class={`attachment-chip ${attachment.kind}`} key={attachmentKey(attachment, index)}>
            <Icon name={attachment.kind === "path" ? "folder" : "upload"} size={13} />
            <span class="attachment-chip-copy">
              <span class="attachment-chip-title">{attachmentTitle(attachment)}</span>
              <span class="attachment-chip-meta">{attachmentMeta(attachment)}</span>
            </span>
            {attachment.href && (
              <a class="attachment-chip-link" href={attachment.href} target="_blank" rel="noreferrer">
                Open
              </a>
            )}
            {!disabled && (
              <IconButton
                size="sm"
                aria-label="Remove attachment"
                title="Remove attachment"
                icon={<Icon name="trash" size={12} />}
                onClick={() => removeAttachment(index)}
                disabled={disabled}
              />
            )}
          </span>
        ))}
        {uploading && <span class="attachment-chip pending"><Icon name="upload" size={13} /> Uploading image...</span>}
        {uploadError && <span class="attachment-chip error">{uploadError}</span>}
      </div>
    </div>
  );
}
