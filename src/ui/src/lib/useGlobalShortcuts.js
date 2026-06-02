// §5.9 Global shortcut registry + handler.
// Text-entry surfaces win over list shortcuts; global shortcuts disable while
// a modal or menu owns focus, except Esc.

import { useEffect, useRef } from "preact/hooks";

function isTextTarget(target) {
  if (!target) return false;
  const tag = target.tagName?.toLowerCase?.() || "";
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (target.isContentEditable) return true;
  return false;
}

function overlayActive() {
  if (typeof document === "undefined") return false;
  return Boolean(
    document.querySelector(".modal-backdrop") ||
    document.querySelector(".drawer") ||
    document.querySelector(".select-menu") ||
    document.querySelector("[role='menu']")
  );
}

// Hook consumers provide a table of { key, alt, cmd, handler } and the
// effect registers once on the window. Multiple components can register.
export function useGlobalShortcuts(map = {}) {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => {
    function onKey(e) {
      const key = e.key;
      const target = e.target;
      const typing = isTextTarget(target);
      const hasOverlay = overlayActive();
      // Esc always flows through.
      if (key === "Escape") {
        ref.current["Escape"]?.(e);
        return;
      }
      if (hasOverlay) return; // suppress other shortcuts while overlay is open
      if (typing) {
        // text-entry surfaces: only ⌘S / ⌘Enter ride through.
        if ((e.metaKey || e.ctrlKey) && (key === "s" || key === "S" || key === "Enter")) {
          const combo = key === "Enter" ? "cmdenter" : "cmds";
          ref.current[combo]?.(e);
        }
        return;
      }
      if (e.metaKey || e.ctrlKey) {
        if (key === "s" || key === "S") ref.current["cmds"]?.(e);
        else if (key === "Enter") ref.current["cmdenter"]?.(e);
        else if (key === "\\") ref.current["cmdbackslash"]?.(e);
        return;
      }
      if (e.altKey) return;
      // Case-insensitive match for single-character keys.
      const handler = ref.current[key] || ref.current[key.toLowerCase?.()] || ref.current[key.toUpperCase?.()];
      if (handler) handler(e);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
