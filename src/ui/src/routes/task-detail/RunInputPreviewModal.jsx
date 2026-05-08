import { Button } from "../../components/primitives/Button.jsx";
import { FormField } from "../../components/FormField.jsx";
import { Icon } from "../../components/Icon.jsx";
import { InlineHead } from "../../components/layout/index.js";
import { Modal } from "../../components/Modal.jsx";
import { Textarea } from "../../components/primitives/Textarea.jsx";
import { normalizeRunPreviewInput, runPreviewMetadataItems } from "./runPreview.js";

export function RunInputPreviewModal({
  open,
  onClose,
  preview,
  loading,
  error,
  onCopy,
}) {
  const input = preview ? normalizeRunPreviewInput(preview) : null;
  const meta = input ? runPreviewMetadataItems(input.metadata) : [];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Run input"
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button
            variant="primary"
            iconLeft={<Icon name="copy" size={13} />}
            onClick={onCopy}
            disabled={!preview || loading}
          >
            Copy all
          </Button>
        </>
      }
    >
      <div class="run-input-preview">
        {loading && <div class="field-hint">Loading run input...</div>}
        {error && <div class="run-input-preview-error">{error}</div>}
        {preview && (
          <>
            <div class="run-input-preview-meta">
              {meta.map(([label, value]) => (
                <div key={label} class="run-input-preview-meta-item">
                  <span>{label}</span>
                  <strong>{value}</strong>
                </div>
              ))}
            </div>
            <FormField label="System message" class="run-input-preview-field">
              <Textarea
                rows={14}
                monospace
                readOnly
                class="run-input-preview-textarea"
                aria-label="System message"
                value={input.system.content || ""}
              />
            </FormField>
            <FormField label="User messages" class="run-input-preview-field">
              <div class="run-input-preview-message-list">
                {input.messages.map((message, index) => (
                  <div key={`${message.role}-${index}`} class="run-input-preview-message">
                    <InlineHead class="run-input-preview-message-head">
                      <code>{message.role || "message"}</code>
                      <span>{message.format || "plain"}</span>
                    </InlineHead>
                    <Textarea
                      rows={6}
                      monospace
                      readOnly
                      class="run-input-preview-textarea run-input-preview-messages"
                      aria-label={`User message ${index + 1}`}
                      value={message.content || ""}
                    />
                  </div>
                ))}
                {!input.messages.length && <div class="field-hint">No user messages.</div>}
              </div>
            </FormField>
            {!!input.tools.length && (
              <div class="run-input-preview-tools" aria-label="On-demand tools">
                <span>On-demand tools</span>
                <ul>
                  {input.tools.map((tool) => (
                    <li key={tool.name}>
                      <code>{tool.name}</code>
                      {tool.purpose && <span>{tool.purpose}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
