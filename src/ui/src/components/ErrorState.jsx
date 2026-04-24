// §4.14 ErrorState — red-tinted icon, title "Something broke", Retry CTA.
import { Button } from "./primitives/Button.jsx";
import { Icon } from "./Icon.jsx";

export function ErrorState({
  title = "Something broke",
  message,
  onRetry,
  retryLabel = "Retry",
  class: className = "",
  children,
}) {
  return (
    <div class={`error-state ${className}`.trim()} role="alert">
      <div class="error-state-icon" aria-hidden="true">
        <Icon name="alert-triangle" size={48} />
      </div>
      <h3 class="error-state-title">{title}</h3>
      {message && <p class="error-state-body">{message}</p>}
      {children}
      {onRetry && (
        <div class="error-state-cta">
          <Button variant="primary" onClick={onRetry}>{retryLabel}</Button>
        </div>
      )}
    </div>
  );
}
