import { describe, expect, it } from "vitest";
import {
  attachmentPayload,
  pathAttachmentDraft,
  uploadedAttachmentDraft,
} from "../../ui/src/lib/attachments.js";

describe("UI attachment helpers", () => {
  it("serializes existing attachments by id so patching preserves them", () => {
    expect(attachmentPayload([
      { id: "att-existing", kind: "path", path_text: "src/app.js", label: "App" },
    ])).toEqual([{ id: "att-existing" }]);
  });

  it("serializes new path attachments with labels", () => {
    expect(attachmentPayload([
      pathAttachmentDraft("src/core/run-input.js", "Run input"),
    ])).toEqual([
      { kind: "path", path: "src/core/run-input.js", label: "Run input" },
    ]);
  });

  it("serializes pasted image uploads by temporary upload id", () => {
    const draft = uploadedAttachmentDraft({
      id: "upload-1",
      filename: "clip.png",
      mime_type: "image/png",
      size_bytes: 8,
    }, "Clipboard image");

    expect(draft).toMatchObject({
      kind: "upload",
      upload_id: "upload-1",
      filename: "clip.png",
      mime_type: "image/png",
      size_bytes: 8,
      label: "Clipboard image",
    });
    expect(attachmentPayload([draft])).toEqual([
      { kind: "upload", upload_id: "upload-1", label: "Clipboard image" },
    ]);
  });
});
