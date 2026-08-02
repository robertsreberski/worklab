import { Fragment, h } from "preact";
import { afterAll, describe, expect, it } from "vitest";
import { AcpHealthCard, acpHealthView } from "../../ui/src/components/external-agents/AcpHealthCard.jsx";

const previousReact = globalThis.React;
globalThis.React = { createElement: h, Fragment };
afterAll(() => {
  if (previousReact === undefined) delete globalThis.React;
  else globalThis.React = previousReact;
});

function descendants(value, output = []) {
  if (Array.isArray(value)) {
    value.forEach((entry) => descendants(entry, output));
    return output;
  }
  if (!value || typeof value !== "object") return output;
  output.push(value);
  descendants(value.props?.children, output);
  return output;
}

describe("ACP health card", () => {
  it("reads health metadata only from persisted probe result shapes", () => {
    const view = acpHealthView({
      health: "healthy",
      capabilities: { terminal: true },
      installedVersion: "fabricated-top-level",
      lastProbe: {
        state: "succeeded",
        at: "2026-08-02T12:00:00.000Z",
        result: {
          status: "ready",
          installedVersion: "0.18.0",
          protocolVersion: 1,
          bridgeVersion: 1,
          authenticated: true,
          capabilities: { sessions: true, terminal: false },
        },
      },
    });

    expect(view).toMatchObject({
      status: "complete",
      label: "Ready",
      installedVersion: "0.18.0",
      protocolVersion: 1,
      bridgeVersion: 1,
      authenticated: true,
      capabilities: { sessions: true, terminal: false },
    });
    expect(JSON.stringify(view)).not.toContain("fabricated-top-level");
  });

  it("uses a probe operation result but ignores non-probe operation results", () => {
    const profile = {
      lastProbe: { state: "succeeded", result: { status: "ready", installedVersion: "0.18.0" } },
    };
    expect(acpHealthView(profile, {
      kind: "probe",
      state: "succeeded",
      result: { status: "healthy", installedVersion: "0.18.1" },
    }).installedVersion).toBe("0.18.1");
    expect(acpHealthView(profile, {
      kind: "list_sessions",
      state: "succeeded",
      result: { status: "not-health", installedVersion: "wrong" },
    }).installedVersion).toBe("0.18.0");
  });

  it("announces probe and authentication state and exposes errors as alerts", () => {
    const tree = AcpHealthCard({
      profile: {
        lastProbe: {
          state: "failed",
          error: { code: "probe_failed", message: "ACP probe failed." },
          result: {},
        },
      },
      probing: false,
      authenticatingMethodId: "browser-login",
    });
    const nodes = descendants(tree.props.children);
    const status = nodes.find((node) => node.props?.role === "status");
    const alert = nodes.find((node) => node.props?.role === "alert");

    expect(status?.props).toMatchObject({ "aria-live": "polite", "aria-atomic": "true" });
    expect(status?.props.children).toBe("ACP authentication is in progress.");
    expect(alert?.props["aria-live"]).toBe("assertive");
    expect(alert?.props.children).toBe("ACP probe failed.");
  });
});
