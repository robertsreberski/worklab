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

export function transferFiles(transfer) {
  return Array.from(transfer?.files || []).filter(Boolean);
}

export function imageFilesFromTransfer(transfer) {
  return transferFiles(transfer).filter((file) => file.type?.startsWith("image/"));
}

export function transferHasFiles(transfer) {
  if (transferFiles(transfer).length > 0) return true;
  return Array.from(transfer?.items || []).some((item) => item.kind === "file");
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
