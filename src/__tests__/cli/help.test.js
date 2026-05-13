import { describe, expect, it } from "vitest";
import {
  formatCommandHelp,
  formatGeneralHelp,
  resolveHelpTopic,
} from "../../cli/help.js";

describe("CLI help", () => {
  it("describes available commands and common config flags", () => {
    const help = formatGeneralHelp();

    expect(help).toContain("Usage: worklab <command> [options]");
    expect(help).toContain("Local agent orchestration app");
    expect(help).toContain("compact-logs");
    expect(help).toContain("install-skill");
    expect(help).toContain("onboard");
    expect(help).toContain("doctor performance");
    expect(help).toContain("--port PORT");
    expect(help).toContain("--data-dir DIR");
  });

  it("documents onboard options", () => {
    const help = formatCommandHelp("onboard");

    expect(help).toContain("Usage: worklab onboard [options]");
    expect(help).toContain("--yes");
    expect(help).toContain("--dry-run");
    expect(help).toContain("--local-provider NAME");
    expect(help).toContain("--embedding MODE");
    expect(help).toContain("--no-start");
  });

  it("documents install-skill options", () => {
    const help = formatCommandHelp("install-skill");

    expect(help).toContain("Usage: worklab install-skill --target codex|claude|all [options]");
    expect(help).toContain("--target TARGET");
    expect(help).toContain("--copy");
    expect(help).toContain("--force");
    expect(help).toContain("--dry-run");
  });

  it("documents compact-logs options", () => {
    const help = formatCommandHelp("compact-logs");

    expect(help).toContain("Usage: worklab compact-logs [options]");
    expect(help).toContain("--apply");
    expect(help).toContain("--strategy NAME");
    expect(help).toContain("--recompact");
    expect(help).toContain("--min-age-days DAYS");
    expect(help).toContain("--min-bytes BYTES");
    expect(help).toContain("--keep-events COUNT");
    expect(help).toContain("--max-event-bytes BYTES");
    expect(help).toContain("--max-log-bytes BYTES");
    expect(help).toContain("--vacuum");
    expect(help).toContain("--json");
  });

  it("resolves top-level, command, and nested command help topics", () => {
    expect(resolveHelpTopic(undefined, ["--help"])).toBe(null);
    expect(resolveHelpTopic("compact-logs", ["--help"])).toBe("compact-logs");
    expect(resolveHelpTopic("doctor", ["performance", "--help"])).toBe("doctor performance");
    expect(resolveHelpTopic("help", ["doctor", "performance"])).toBe("doctor performance");
  });
});
