import { Modal } from "../Modal.jsx";
import { Icon } from "../Icon.jsx";

const CHOICES = [
  {
    mode: "local",
    icon: "user",
    title: "Local Worklab agent",
    description: "Configure a model, instructions, skills, MCP servers, and built-in tools managed by Worklab.",
  },
  {
    mode: "mono",
    icon: "search",
    title: "Import mono-agent",
    description: "Discover a running mono-agent source and attach through its sanitized ACP descriptor.",
  },
  {
    mode: "external",
    icon: "terminal",
    title: "Manual stdio ACP agent",
    description: "Launch any ACP-compatible executable over stdio with an explicit ownership and permission policy.",
  },
];

export function NewAgentChooserModal({ open, onClose, onChoose }) {
  return (
    <Modal open={open} onClose={onClose} title="Create an agent" size="lg" class="agent-create-chooser-modal">
      <p class="soft-meta">Choose where the agent runs. Every choice becomes one assignable Agent resource in Worklab.</p>
      <div class="agent-create-choices" role="list">
        {CHOICES.map((choice) => (
          <button
            key={choice.mode}
            type="button"
            class="agent-create-choice"
            role="listitem"
            onClick={() => onChoose?.(choice.mode)}
          >
            <span class="agent-create-choice-icon" aria-hidden="true"><Icon name={choice.icon} size={18} /></span>
            <span class="agent-create-choice-copy">
              <span class="agent-create-choice-title">{choice.title}</span>
              <span class="agent-create-choice-description">{choice.description}</span>
            </span>
            <Icon name="chevron-right" size={16} class="agent-create-choice-arrow" />
          </button>
        ))}
      </div>
    </Modal>
  );
}
