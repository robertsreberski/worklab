import { useEffect, useState } from "preact/hooks";
import { subscribeToasts, dismissToast } from "../lib/toast.js";

export function ToastHost() {
  const [items, setItems] = useState([]);
  useEffect(() => subscribeToasts(setItems), []);
  if (!items.length) return null;
  return (
    <div class="toast-host" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} class={`toast toast-${t.variant}`}>
          <span class="toast-message">{t.message}</span>
          <button type="button" class="toast-close" aria-label="Dismiss notification" onClick={() => dismissToast(t.id)}>×</button>
        </div>
      ))}
    </div>
  );
}
