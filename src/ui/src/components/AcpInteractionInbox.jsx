import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api } from "../lib/api.js";
import {
  acpElicitationDecision,
  acpFormInitialValues,
  acpFormResponse,
  acpFormValues,
  acpInteractionCanAutoOpen,
  acpInteractionEventRequiresRefresh,
  acpInteractionIsReconnectEvent,
  acpInteractionIsStale,
  acpPermissionResponse,
  normalizePendingAcpInteractions,
} from "../lib/acpInteractions.js";
import { acpEndpointUnsupported } from "../lib/externalAgents.js";
import { useSSE } from "../lib/useSSE.js";
import { pushToast } from "../lib/toast.js";
import { Banner } from "./Banner.jsx";
import { Icon } from "./Icon.jsx";
import { Modal } from "./Modal.jsx";
import { FormField } from "./FormField.jsx";
import { Input } from "./primitives/Input.jsx";
import { Select } from "./primitives/Select.jsx";
import { Checkbox } from "./primitives/Checkbox.jsx";
import { Button } from "./primitives/Button.jsx";

const RELOAD_DELAY_MS = 60;

function interactionHeading(interaction) {
  if (interaction?.kind === "permission") return "Agent permission requested";
  if (interaction?.kind === "url") return "Continue in your browser";
  return interaction?.title || "Agent input requested";
}

function interactionContext(interaction) {
  if (interaction?.taskRunId) return { label: "Task run", value: interaction.taskRunId };
  if (interaction?.operationId) return { label: "Profile operation", value: interaction.operationId };
  return { label: "External agent", value: interaction?.profileId || "ACP" };
}

function permissionButtonVariant(option, index) {
  if (option.kind.startsWith("reject")) return "destructive";
  return index === 0 ? "primary" : "secondary";
}

function inputType(field) {
  if (field.type === "number" || field.type === "integer") return "number";
  if (field.format === "email") return "email";
  if (field.format === "uri") return "url";
  if (field.format === "date") return "date";
  if (field.format === "date-time") return "datetime-local";
  return "text";
}

function FormInteractionFields({ interaction, values, errors, onChange, firstControlRef }) {
  if (interaction.fields.length === 0) {
    return <div class="acp-interaction-empty">This request has no safe fields to collect.</div>;
  }
  return (
    <div
      class="acp-interaction-form-fields"
      ref={(node) => {
        firstControlRef.current = node?.querySelector("input:not([disabled]), select:not([disabled])") || null;
      }}
    >
      {interaction.fields.map((field, index) => {
        const fieldId = `acp-interaction-field-${index}`;
        if (field.type === "boolean") {
          return (
            <FormField key={field.key} switchInside>
              <Checkbox
                id={fieldId}
                checked={values[field.key] === true}
                label={field.label}
                description={field.description}
                onChange={(checked) => onChange(field.key, checked)}
              />
            </FormField>
          );
        }
        if (field.type === "array") {
          const selected = Array.isArray(values[field.key]) ? values[field.key] : [];
          return (
            <fieldset class="acp-interaction-multiselect" key={field.key} aria-describedby={errors[field.key] ? `${fieldId}-error` : undefined}>
              <legend>{field.label}{field.required && <span aria-hidden="true"> *</span>}</legend>
              {field.description && <div class="form-field-hint">{field.description}</div>}
              <div class="acp-interaction-multiselect-options">
                {field.choices.map((choice, choiceIndex) => (
                  <Checkbox
                    id={`${fieldId}-${choiceIndex}`}
                    key={choice.value}
                    checked={selected.includes(choice.value)}
                    label={choice.label}
                    description={choice.description}
                    onChange={(checked) => {
                      const next = new Set(selected);
                      if (checked) next.add(choice.value); else next.delete(choice.value);
                      onChange(field.key, [...next]);
                    }}
                  />
                ))}
              </div>
              {errors[field.key] && <div id={`${fieldId}-error`} class="form-field-error" role="alert">{errors[field.key]}</div>}
            </fieldset>
          );
        }
        if (field.choices.length > 0) {
          const errorId = errors[field.key] ? `${fieldId}-error` : undefined;
          return (
            <FormField
              key={field.key}
              label={field.label}
              required={field.required}
              hint={field.description}
              error={errors[field.key]}
              errorId={errorId}
              htmlFor={fieldId}
            >
              <Select
                id={fieldId}
                variant="native"
                ariaLabel={field.label}
                ariaDescribedBy={errorId}
                invalid={!!errors[field.key]}
                value={values[field.key] || ""}
                placeholder="Choose…"
                options={field.choices}
                onChange={(value) => onChange(field.key, value)}
              />
            </FormField>
          );
        }
        const errorId = errors[field.key] ? `${fieldId}-error` : undefined;
        return (
          <FormField
            key={field.key}
            label={field.label}
            required={field.required}
            hint={field.description}
            error={errors[field.key]}
            errorId={errorId}
            htmlFor={fieldId}
          >
            <Input
              id={fieldId}
              type={inputType(field)}
              step={field.type === "integer" ? 1 : field.type === "number" ? "any" : undefined}
              min={field.minimum ?? undefined}
              max={field.maximum ?? undefined}
              minLength={field.minLength ?? undefined}
              maxLength={field.maxLength ?? undefined}
              value={values[field.key] ?? ""}
              autoComplete="off"
              aria-invalid={errors[field.key] ? "true" : undefined}
              aria-describedby={errorId}
              onInput={(event) => onChange(field.key, event.currentTarget.value)}
            />
          </FormField>
        );
      })}
    </div>
  );
}

export function AcpInteractionInbox() {
  const [interactions, setInteractions] = useState([]);
  const [activeId, setActiveId] = useState("");
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState({});
  const [fieldErrors, setFieldErrors] = useState({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(false);
  const [openedUrlId, setOpenedUrlId] = useState("");
  const [unsupported, setUnsupported] = useState(false);
  const initializedRef = useRef(false);
  const knownIdsRef = useRef(new Set());
  const reloadTimerRef = useRef(null);
  const loadControllerRef = useRef(null);
  const loadGenerationRef = useRef(0);
  const firstControlRef = useRef(null);
  const fallbackControlRef = useRef(null);
  const errorRef = useRef(null);
  const errorFocusModeRef = useRef("banner");
  const openedUrlIdRef = useRef("");

  const activeIndex = Math.max(0, interactions.findIndex((interaction) => interaction.id === activeId));
  const active = interactions[activeIndex] || null;
  const hasUnsafeRequiredFields = !!active && [...active.blockedFields, ...active.unsupportedFields].some((field) => field.required);

  const invalidateLoad = useCallback(() => {
    loadGenerationRef.current += 1;
    loadControllerRef.current?.abort();
    loadControllerRef.current = null;
    setLoading(false);
  }, []);

  const focusActiveControl = useCallback(() => {
    const primary = firstControlRef.current;
    (primary && !primary.disabled ? primary : fallbackControlRef.current)?.focus?.();
  }, []);

  const load = useCallback(async ({ revealNew = false } = {}) => {
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    loadControllerRef.current?.abort();
    const controller = new AbortController();
    loadControllerRef.current = controller;
    setLoading(true);
    try {
      const response = await api.listAcpInteractions({ state: "pending" }, { signal: controller.signal });
      if (generation !== loadGenerationRef.current) return;
      const next = normalizePendingAcpInteractions(response);
      const hadInitialized = initializedRef.current;
      const hasNew = next.some((interaction) => !knownIdsRef.current.has(interaction.id));
      initializedRef.current = true;
      knownIdsRef.current = new Set(next.map((interaction) => interaction.id));
      setInteractions(next);
      setActiveId((current) => next.some((interaction) => interaction.id === current) ? current : (next[0]?.id || ""));
      if (next.length === 0) setOpen(false);
      else if ((!hadInitialized || (revealNew && hasNew)) && acpInteractionCanAutoOpen()) setOpen(true);
      setUnsupported(false);
      setLoadError("");
    } catch (loadError) {
      if (loadError?.name === "AbortError" || generation !== loadGenerationRef.current) return;
      if (acpEndpointUnsupported(loadError)) {
        setUnsupported(true);
        setInteractions([]);
        setOpen(false);
        setLoadError("");
        return;
      }
      setLoadError(loadError?.message || "Pending agent requests could not be loaded.");
    } finally {
      if (loadControllerRef.current === controller) loadControllerRef.current = null;
      if (generation === loadGenerationRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    return () => {
      invalidateLoad();
      if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current);
    };
  }, [invalidateLoad, load]);

  useSSE("global", (event) => {
    if (!acpInteractionEventRequiresRefresh(event) || unsupported) return;
    if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current);
    reloadTimerRef.current = setTimeout(() => load({
      revealNew: !acpInteractionIsReconnectEvent(event),
    }), RELOAD_DELAY_MS);
  });

  useEffect(() => {
    const reconcile = () => {
      if (document.visibilityState !== "hidden") load();
    };
    document.addEventListener("visibilitychange", reconcile);
    window.addEventListener("focus", reconcile);
    window.addEventListener("online", reconcile);
    return () => {
      document.removeEventListener("visibilitychange", reconcile);
      window.removeEventListener("focus", reconcile);
      window.removeEventListener("online", reconcile);
    };
  }, [load]);

  useEffect(() => {
    setValues(active?.kind === "form" ? acpFormInitialValues(active) : {});
    setFieldErrors({});
    setError("");
    setOpenedUrlId("");
    openedUrlIdRef.current = "";
  }, [active?.id, active?.kind]);

  useEffect(() => {
    if (!open || !active?.id) return undefined;
    const frame = window.requestAnimationFrame(focusActiveControl);
    return () => window.cancelAnimationFrame(frame);
  }, [active?.id, focusActiveControl, open]);

  useEffect(() => {
    if (!open || !error || errorFocusModeRef.current !== "banner") return undefined;
    const frame = window.requestAnimationFrame(() => errorRef.current?.focus?.());
    return () => window.cancelAnimationFrame(frame);
  }, [error, open]);

  const context = useMemo(() => interactionContext(active), [active]);

  const clearPrivateDraft = useCallback(() => {
    setValues({});
    setFieldErrors({});
  }, []);

  const close = useCallback(() => {
    clearPrivateDraft();
    setError("");
    setOpen(false);
  }, [clearPrivateDraft]);

  function chooseIndex(index) {
    const next = interactions[index];
    if (!next) return;
    clearPrivateDraft();
    setActiveId(next.id);
  }

  function removeSettled(id) {
    knownIdsRef.current.delete(id);
    const next = interactions.filter((interaction) => interaction.id !== id);
    setInteractions(next);
    setActiveId((selected) => selected === id ? (next[0]?.id || "") : selected);
    if (next.length === 0) setOpen(false);
  }

  async function settle(action, request) {
    if (!active || busy) return;
    const id = active.id;
    errorFocusModeRef.current = "banner";
    setError("");
    setBusy(action);
    invalidateLoad();
    try {
      if (action === "cancel") await api.cancelAcpInteraction(id);
      else await api.respondAcpInteraction(id, request);
      clearPrivateDraft();
      removeSettled(id);
      await load();
    } catch (settleError) {
      if (acpInteractionIsStale(settleError)) {
        clearPrivateDraft();
        removeSettled(id);
        pushToast("Agent request was already resolved.", { variant: "info" });
        await load();
      } else {
        errorFocusModeRef.current = "banner";
        setError(settleError?.message || "The agent request could not be resolved.");
      }
    } finally {
      setBusy("");
    }
  }

  function submitPermission(optionId) {
    try {
      settle(`permission:${optionId}`, acpPermissionResponse(active, optionId));
    } catch (responseError) {
      errorFocusModeRef.current = "banner";
      setError(responseError.message);
    }
  }

  function focusFirstFieldError(errors) {
    const firstInvalidIndex = active.fields.findIndex((field) => errors[field.key]);
    errorFocusModeRef.current = firstInvalidIndex >= 0 ? "field" : "banner";
    window.requestAnimationFrame(() => {
      if (firstInvalidIndex < 0) {
        errorRef.current?.focus?.();
        return;
      }
      const fieldId = `acp-interaction-field-${firstInvalidIndex}`;
      const control = document.getElementById(fieldId)
        || document.querySelector(`[id^="${fieldId}-"]`);
      (control || errorRef.current)?.focus?.();
    });
  }

  function submitForm(event) {
    event.preventDefault();
    const validation = acpFormValues(active, values);
    if (Object.keys(validation.errors).length > 0) {
      setFieldErrors(validation.errors);
      setError("Complete the required form fields before submitting.");
      focusFirstFieldError(validation.errors);
      return;
    }
    try {
      settle("form", acpFormResponse(active, values));
    } catch (responseError) {
      const nextErrors = responseError.fieldErrors || {};
      setFieldErrors(nextErrors);
      setError(responseError.message);
      focusFirstFieldError(nextErrors);
    }
  }

  function decline() {
    settle("decline", acpElicitationDecision("decline"));
  }

  function markUrlOpened(event) {
    const id = active?.id || "";
    if (!id || openedUrlIdRef.current === id) {
      event.preventDefault();
      return;
    }
    openedUrlIdRef.current = id;
    setOpenedUrlId(id);
    setError("");
    window.requestAnimationFrame(focusActiveControl);
  }

  if (unsupported) return null;
  if (interactions.length === 0 || !active) {
    if (!loadError) return null;
    return (
      <div class="acp-interaction-load-error" role="alert">
        <span>Pending agent requests could not be loaded.</span>
        <Button size="sm" variant="secondary" loading={loading} onClick={() => load()}>Retry</Button>
      </div>
    );
  }

  const formId = "acp-interaction-response-form";
  const urlFormId = `acp-interaction-url-open-${active.id}`;
  const urlWasOpened = active.kind === "url" && openedUrlId === active.id;
  const footer = (
    <div class="acp-interaction-footer">
      <div class="acp-interaction-queue-controls" aria-label="Pending agent requests">
        <Button size="sm" variant="ghost" disabled={busy || activeIndex === 0} onClick={() => chooseIndex(activeIndex - 1)}>Previous</Button>
        <span aria-live="polite">{activeIndex + 1} of {interactions.length}</span>
        <Button size="sm" variant="ghost" disabled={busy || activeIndex >= interactions.length - 1} onClick={() => chooseIndex(activeIndex + 1)}>Next</Button>
      </div>
      <div class="acp-interaction-actions">
        {active.kind !== "permission" && (
          <Button size="sm" variant="secondary" disabled={!!busy} loading={busy === "decline"} onClick={decline}>Decline</Button>
        )}
        <Button
          buttonRef={fallbackControlRef}
          size="sm"
          variant="ghost"
          disabled={!!busy}
          loading={busy === "cancel"}
          onClick={() => settle("cancel")}
        >Cancel request</Button>
        {active.kind === "form" && (
          <Button size="sm" variant="primary" type="submit" form={formId} disabled={!!busy || hasUnsafeRequiredFields} loading={busy === "form"}>Submit</Button>
        )}
        {active.kind === "url" && (
          <Button
            key="open-url"
            buttonRef={!urlWasOpened && active.url ? firstControlRef : undefined}
            size="sm"
            variant="primary"
            type="submit"
            form={urlFormId}
            disabled={!!busy || !active.url || urlWasOpened}
          >{urlWasOpened ? "Link opened" : "Open link"}</Button>
        )}
        {active.kind === "url" && urlWasOpened && (
          <Button
            key="continue-agent"
            buttonRef={firstControlRef}
            size="sm"
            variant="primary"
            disabled={!!busy}
            loading={busy === "accept"}
            onClick={() => settle("accept", acpElicitationDecision("accept"))}
          >Continue agent</Button>
        )}
      </div>
    </div>
  );

  return (
    <>
      <button
        type="button"
        class="acp-interaction-launcher"
        aria-label={`${interactions.length} pending agent ${interactions.length === 1 ? "request" : "requests"}`}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <Icon name="hand" size={16} />
        <span>Agent request</span>
        <strong>{interactions.length}</strong>
      </button>
      <Modal
        open={open}
        onClose={close}
        title={interactionHeading(active)}
        size="md"
        class="acp-interaction-modal"
        footer={footer}
        closeOnBackdrop={false}
        initialFocusRef={fallbackControlRef}
      >
        <div class="acp-interaction-context">
          <span>{context.label}</span>
          <code>{context.value}</code>
        </div>
        {active.message && <p class="acp-interaction-message">{active.message}</p>}
        {loadError && (
          <Banner
            variant="warn"
            title="Pending requests may be out of date"
            detail={loadError}
            actions={<Button size="sm" variant="secondary" loading={loading} onClick={() => load()}>Retry</Button>}
            dismissible={false}
          />
        )}
        {error && (
          <div id="acp-interaction-error" ref={errorRef} tabIndex={-1}>
            <Banner variant="error" title="Request not resolved" detail={error} dismissible={false} />
          </div>
        )}

        {active.kind === "permission" && (
          <div class="acp-interaction-permission">
            {active.toolCall?.title && (
              <div class="acp-interaction-tool">
                <Icon name="terminal" size={16} />
                <div>
                  <strong>{active.toolCall.title}</strong>
                  {(active.toolCall.kind || active.toolCall.status) && <span>{[active.toolCall.kind, active.toolCall.status].filter(Boolean).join(" · ")}</span>}
                </div>
              </div>
            )}
            {active.options.length > 0 ? (
              <div
                class="acp-interaction-permission-options"
                aria-label="Permission choices"
                ref={(node) => {
                  firstControlRef.current = node?.querySelector("button:not([disabled])") || null;
                }}
              >
                {active.options.map((option, index) => (
                  <Button
                    key={option.id}
                    variant={permissionButtonVariant(option, index)}
                    loading={busy === `permission:${option.id}`}
                    disabled={!!busy}
                    onClick={() => submitPermission(option.id)}
                  >
                    {option.label}
                  </Button>
                ))}
              </div>
            ) : (
              <Banner variant="warn" title="No permission choices available" detail="Cancel this request and retry the agent operation." dismissible={false} />
            )}
          </div>
        )}

        {active.kind === "form" && (
          <form
            id={formId}
            class="acp-interaction-form"
            autoComplete="off"
            aria-describedby={error ? "acp-interaction-error" : undefined}
            onSubmit={submitForm}
          >
            {active.blockedFields.length > 0 && (
              <Banner
                variant="warn"
                title="Sensitive fields were withheld"
                detail="Worklab does not collect passwords, tokens, credentials, or other secret values in ACP forms. Use a URL-based flow instead."
                dismissible={false}
              />
            )}
            {active.unsupportedFields.length > 0 && (
              <Banner
                variant="info"
                title="Some fields are not supported"
                detail="Only ACP primitive and enum form fields are rendered."
                dismissible={false}
              />
            )}
            <FormInteractionFields
              interaction={active}
              values={values}
              errors={fieldErrors}
              onChange={(key, value) => {
                setValues((current) => ({ ...current, [key]: value }));
                setFieldErrors((current) => ({ ...current, [key]: undefined }));
                setError("");
              }}
              firstControlRef={firstControlRef}
            />
          </form>
        )}

        {active.kind === "url" && (
          <div class="acp-interaction-url">
            {active.url ? (
              <div class="acp-interaction-url-link">
                <Icon name="external" size={16} />
                <span>{active.url}</span>
              </div>
            ) : (
              <Banner variant="warn" title="No safe link available" detail="Decline or cancel this request." dismissible={false} />
            )}
            {active.url && (
              <form
                id={urlFormId}
                class="sr-only"
                method="post"
                action={api.acpInteractionUrlOpenPath(active.id)}
                target="_blank"
                rel="noopener noreferrer"
                aria-hidden="true"
                onSubmit={markUrlOpened}
              />
            )}
            <p class="soft-meta">
              {urlWasOpened
                ? "After finishing in the new tab, continue the agent."
                : "Open the one-use link only if you trust this external agent."}
            </p>
          </div>
        )}
      </Modal>
    </>
  );
}
