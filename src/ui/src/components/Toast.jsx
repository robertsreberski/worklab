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
          <div class="toast-row">
            <span class="toast-message">{t.message}</span>
            <button
              type="button"
              class="toast-dismiss"
              aria-label="Dismiss notification"
              onClick={() => dismissToast(t.id)}
            >×</button>
          </div>
        </div>
      ))}
    </div>
  );
}
