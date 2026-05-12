export function pathAttachmentDraft(path, label = "") {
  const cleanPath = String(path || "").trim();
  if (!cleanPath) return null;
  return {
    client_id: `path-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    kind: "path",
    path: cleanPath,
    path_text: cleanPath,
    label: String(label || "").trim(),
  };
}

export function uploadedAttachmentDraft(upload, label = "") {
  if (!upload?.id) return null;
  return {
    client_id: `upload-${upload.id}`,
    kind: "upload",
    upload_id: upload.id,
    source: upload.source || "pasted_image",
    label: String(label || upload.filename || "").trim(),
    filename: upload.filename || "clipboard-image.png",
    mime_type: upload.mime_type || "application/octet-stream",
    size_bytes: upload.size_bytes ?? null,
  };
}

export function attachmentPayload(attachments = []) {
  return (attachments || [])
    .map((attachment) => {
      if (attachment?.id && !attachment.upload_id && !attachment.path) {
        return { id: attachment.id };
      }
      if (attachment?.kind === "path") {
        const path = String(attachment.path || attachment.path_text || "").trim();
        if (!path) return null;
        return {
          kind: "path",
          path,
          label: String(attachment.label || "").trim(),
        };
      }
      if (attachment?.kind === "upload") {
        if (attachment.id && !attachment.upload_id) return { id: attachment.id };
        if (!attachment.upload_id) return null;
        return {
          kind: "upload",
          upload_id: attachment.upload_id,
          label: String(attachment.label || attachment.filename || "").trim(),
        };
      }
      return null;
    })
    .filter(Boolean);
}
