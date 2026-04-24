// §5.9 Keyboard help drawer — discoverable list of every shortcut.
import { Drawer } from "./Drawer.jsx";
import { Kbd } from "./primitives/Kbd.jsx";

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
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-5)" }}>
        {SHORTCUTS.map((section) => (
          <section key={section.title}>
            <h3 class="all-caps" style={{ margin: 0, marginBottom: "var(--sp-2)" }}>{section.title}</h3>
            <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "var(--sp-2) var(--sp-4)" }}>
              {section.rows.map((row) => (
                <>
                  <dt style={{ display: "inline-flex", gap: "var(--sp-1)" }}>
                    {row.keys.map((k, i) => <Kbd key={i}>{k}</Kbd>)}
                  </dt>
                  <dd style={{ margin: 0, color: "var(--text-muted)" }}>{row.label}</dd>
                </>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Drawer>
  );
}
