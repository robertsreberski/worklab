// §4.9 Toast host — color-coded left border per variant. Hover pauses.
import { useEffect, useState } from "preact/hooks";
import { subscribeToasts, dismissToast, pauseToast, resumeToast } from "../lib/toast.js";

export function ToastHost() {
  const [items, setItems] = useState([]);
  useEffect(() => subscribeToasts(setItems), []);
  if (!items.length) return null;
  const visible = items.slice(-3);
  return (
    <div class="toast-host">
      {visible.map((t) => (
        <div
          key={t.id}
          class={`toast ${t.variant}`}
          role={t.variant === "error" ? "alert" : "status"}
          onMouseEnter={() => pauseToast(t.id)}
          onMouseLeave={() => resumeToast(t.id)}
        >
          <div style={{ display: "flex", gap: "var(--sp-2)", alignItems: "flex-start" }}>
            <span class="toast-message" style={{ flex: 1 }}>{t.message}</span>
            <button
              type="button"
              class="icon-button sm"
              aria-label="Dismiss notification"
              onClick={() => dismissToast(t.id)}
              style={{ width: 18, height: 18 }}
            >×</button>
          </div>
        </div>
      ))}
    </div>
  );
}
