import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as attachments from "../../ui/src/lib/attachments.js";

const repoRoot = resolve(import.meta.dirname, "../../..");
const attachmentChipsPath = resolve(repoRoot, "src/ui/src/components/AttachmentChips.jsx");
const attachmentChipsSource = existsSync(attachmentChipsPath) ? readFileSync(attachmentChipsPath, "utf8") : "";
const taskEditSource = readFileSync(resolve(repoRoot, "src/ui/src/routes/TaskEdit.jsx"), "utf8");
const taskDetailSource = readFileSync(resolve(repoRoot, "src/ui/src/routes/TaskDetail.jsx"), "utf8");
const taskActivitySource = readFileSync(resolve(repoRoot, "src/ui/src/routes/task-detail/TaskActivitySection.jsx"), "utf8");

describe("UI attachment helpers", () => {
  it("serializes existing attachments by id so patching preserves them", () => {
    expect(attachments.attachmentPayload([
      { id: "att-existing", kind: "path", path_text: "src/app.js", label: "App" },
    ])).toEqual([{ id: "att-existing" }]);
  });

  it("does not expose UI-only path attachment drafts", () => {
    expect(attachments.pathAttachmentDraft).toBeUndefined();
  });

  it("serializes pasted image uploads by temporary upload id", () => {
    const draft = attachments.uploadedAttachmentDraft({
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
    expect(attachments.attachmentPayload([draft])).toEqual([
      { kind: "upload", upload_id: "upload-1", label: "Clipboard image" },
    ]);
  });

  it("extracts image files from paste and drop transfers", () => {
    expect(attachments.imageFilesFromTransfer).toBeTypeOf("function");
    const png = { name: "clip.png", type: "image/png" };
    const txt = { name: "notes.txt", type: "text/plain" };

    expect(attachments.imageFilesFromTransfer({ files: [png, txt] })).toEqual([png]);
  });

  it("keeps attachment UI display-only without manual path controls", () => {
    expect(attachmentChipsSource).toContain("export function AttachmentChips");
    expect(attachmentChipsSource).not.toContain("Attach local path");
    expect(attachmentChipsSource).not.toContain("attachment-add-row");
    expect(attachmentChipsSource).not.toContain("pathAttachmentDraft");
  });

  it("wires image dropping through the task and comment text fields", () => {
    expect(taskEditSource).toContain("onDrop={handleAttachmentDrop}");
    expect(taskDetailSource).toContain("onCommentAttachmentDrop={handleCommentAttachmentDrop}");
    expect(taskActivitySource).toContain("onDrop={onCommentAttachmentDrop}");
  });
});
