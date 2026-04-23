import { useEffect } from "preact/hooks";

const FOCUSABLE = 'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Traps Tab/Shift+Tab inside the ref'd element, and calls onEscape when
// Escape is pressed. Focuses the first focusable on mount. Pass a ref
// whose .current points at the root element of the trapped region.
export function useFocusTrap(ref, { active = true, onEscape } = {}) {
  useEffect(() => {
    if (!active) return;
    const root = ref.current;
    if (!root) return;

    const previouslyFocused = document.activeElement;

    function focusables() {
      return Array.from(root.querySelectorAll(FOCUSABLE)).filter((el) => !el.hasAttribute("aria-hidden"));
    }

    // Focus first focusable on mount (if nothing inside already has focus).
    if (!root.contains(document.activeElement)) {
      const first = focusables()[0];
      if (first) first.focus();
    }

    function onKeyDown(e) {
      if (e.key === "Escape" && onEscape) {
        e.preventDefault();
        onEscape();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    root.addEventListener("keydown", onKeyDown);
    return () => {
      root.removeEventListener("keydown", onKeyDown);
      if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
    };
  }, [active, onEscape, ref]);
}
