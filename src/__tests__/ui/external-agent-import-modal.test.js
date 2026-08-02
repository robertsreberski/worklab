import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(fileURLToPath(new URL(
  "../../ui/src/components/external-agents/MonoAgentImportModal.jsx",
  import.meta.url,
)), "utf8");

describe("mono-agent import modal source", () => {
  it("keeps imports single-flight and ignores completion after the modal closes", () => {
    expect(source).toContain("disabled={committing");
    expect(source).toContain("closeOnBackdrop={!committing}");
    expect(source).toContain("if (!committing) onClose?.();");
    expect(source).toContain("if (busySourceRef.current) return;");
    expect(source).toContain("if (!openRef.current || token !== importTokenRef.current) return;");
  });

  it("links an already-bound discovery source without issuing a duplicate import", () => {
    expect(source).toContain('if (source.imported) onImported?.(source.binding?.agentName);');
    expect(source).toContain('? source.binding?.agentName ? "Open agent" : "Imported"');
  });
});
