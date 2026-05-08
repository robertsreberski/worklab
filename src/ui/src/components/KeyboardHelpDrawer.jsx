// §5.9 Keyboard help drawer — discoverable list of every shortcut.
import { Drawer } from "./Drawer.jsx";
import { Kbd } from "./primitives/Kbd.jsx";
import { SectionStack } from "./layout/index.js";

const SHORTCUTS = [
  {
    title: "Navigation",
    rows: [
      { keys: ["N"], label: "New task" },
      { keys: ["/"], label: "Focus search on current list" },
      { keys: ["?"], label: "Open this keyboard help" },
      { keys: ["Esc"], label: "Dismiss overlay, clear focused search" },
    ],
  },
  {
    title: "Editors",
    rows: [
      { keys: ["⌘", "S"], label: "Save the current editor" },
      { keys: ["⌘", "Enter"], label: "Submit composer / trigger primary action" },
    ],
  },
  {
    title: "Commander",
    rows: [
      { keys: ["j"], label: "Next task" },
      { keys: ["k"], label: "Previous task" },
      { keys: ["Enter"], label: "Open selected task" },
      { keys: ["x"], label: "Toggle row checkbox" },
    ],
  },
];

export function KeyboardHelpDrawer({ open, onClose }) {
  return (
    <Drawer open={open} onClose={onClose} title="Keyboard shortcuts">
      <SectionStack class="kbd-help-stack">
        {SHORTCUTS.map((section) => (
          <section key={section.title} class="kbd-help-section">
            <h3 class="all-caps kbd-help-title">{section.title}</h3>
            <dl class="kbd-help-grid">
              {section.rows.map((row, idx) => (
                <>
                  <dt key={`k-${idx}`} class="kbd-help-keys">
                    {row.keys.map((k, i) => <Kbd key={i}>{k}</Kbd>)}
                  </dt>
                  <dd key={`v-${idx}`} class="kbd-help-label">{row.label}</dd>
                </>
              ))}
            </dl>
          </section>
        ))}
      </SectionStack>
    </Drawer>
  );
}
