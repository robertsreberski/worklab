import { describe, expect, it } from "vitest";
import {
  artifactDeltaLabel,
  buildRunArtifactTree,
  extractRunArtifacts,
  runArtifactSummary,
} from "../../ui/src/lib/runArtifacts.js";

describe("run artifact extraction", () => {
  it("builds a nested tree from completed file edit results", () => {
    const artifacts = extractRunArtifacts([
      {
        type: "user",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "file-1",
            content: {
              status: "completed",
              changes: [
                {
                  path: "src/core/run.js",
                  kind: "update",
                  line_stats: { before_lines: 10, after_lines: 12, added_lines: 3, removed_lines: 1 },
                },
                {
                  path: "src/ui/Panel.jsx",
                  kind: "add",
                  line_stats: { before_lines: 0, after_lines: 8, added_lines: 8, removed_lines: 0 },
                },
              ],
            },
          }],
        },
      },
    ]);

    expect(runArtifactSummary(artifacts)).toEqual({
      files: 2,
      added_lines: 11,
      removed_lines: 1,
      pending_files: 0,
      unavailable_count: 0,
    });
    expect(buildRunArtifactTree(artifacts)).toEqual([
      {
        name: "src",
        type: "folder",
        path: "src",
        children: [
          {
            name: "core",
            type: "folder",
            path: "src/core",
            children: [expect.objectContaining({ name: "run.js", type: "file", added_lines: 3, removed_lines: 1 })],
          },
          {
            name: "ui",
            type: "folder",
            path: "src/ui",
            children: [expect.objectContaining({ name: "Panel.jsx", type: "file", added_lines: 8, removed_lines: 0 })],
          },
        ],
      },
    ]);
  });

  it("shows pending files from file edit tool_use events", () => {
    const artifacts = extractRunArtifacts([
      {
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: "file-1",
            name: "file_edit",
            input: {
              status: "in_progress",
              changes: [{ path: "src/ui/TaskDetail.jsx", kind: "update" }],
            },
          }],
        },
      },
    ]);

    expect(artifacts).toEqual([
      expect.objectContaining({
        path: "src/ui/TaskDetail.jsx",
        display_path: "src/ui/TaskDetail.jsx",
        status: "in_progress",
      }),
    ]);
    expect(runArtifactSummary(artifacts).pending_files).toBe(1);
  });

  it("normalizes object-shaped file edit kinds in artifacts", () => {
    const artifacts = extractRunArtifacts([
      {
        type: "tool_result",
        content: {
          status: "completed",
          changes: [{
            path: "src/exact_slack_catchup.py",
            kind: { type: "update", move_path: null },
            line_stats: { before_lines: 10, after_lines: 13, added_lines: 4, removed_lines: 1 },
          }],
        },
      },
    ]);

    expect(artifacts[0]).toMatchObject({
      kind: "update",
      display_path: "src/exact_slack_catchup.py",
      added_lines: 4,
      removed_lines: 1,
    });
  });

  it("aggregates repeated completed edits by path", () => {
    const artifacts = extractRunArtifacts([
      {
        type: "tool_result",
        content: {
          status: "completed",
          changes: [{
            path: "src/a.js",
            kind: "update",
            line_stats: { before_lines: 3, after_lines: 5, added_lines: 2, removed_lines: 0 },
          }],
        },
      },
      {
        type: "tool_result",
        content: {
          status: "completed",
          changes: [{
            path: "src/a.js",
            kind: "update",
            line_stats: { before_lines: 5, after_lines: 4, added_lines: 0, removed_lines: 1 },
          }],
        },
      },
    ]);

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      added_lines: 2,
      removed_lines: 1,
      before_lines: 3,
      after_lines: 4,
    });
    expect(artifactDeltaLabel(artifacts[0])).toBe("+2 -1");
  });

  it("normalizes raw Codex app-server fileChange events", () => {
    const artifacts = extractRunArtifacts([
      {
        type: "item.completed",
        item: {
          type: "fileChange",
          id: "file-1",
          status: "completed",
          changes: [{
            path: "/Users/me/project/src/app.js",
            kind: "update",
            line_stats: { before_lines: 1, after_lines: 2, added_lines: 1, removed_lines: 0 },
          }],
        },
      },
      {
        type: "item.completed",
        item: {
          type: "fileChange",
          id: "file-2",
          status: "completed",
          changes: [{
            path: "/Users/me/project/test/app.test.js",
            kind: "add",
            line_stats: { before_lines: 0, after_lines: 4, added_lines: 4, removed_lines: 0 },
          }],
        },
      },
    ]);

    expect(artifacts.map((item) => item.display_path)).toEqual(["src/app.js", "test/app.test.js"]);
  });

  it("preserves unavailable line stats", () => {
    const artifacts = extractRunArtifacts([
      {
        type: "tool_result",
        content: {
          status: "completed",
          changes: [{
            path: "large.bin",
            kind: "update",
            line_stats: { before_lines: 1000, after_lines: 1000, unavailable_reason: "too_large" },
          }],
        },
      },
    ]);

    expect(artifacts[0]).toMatchObject({
      unavailable_reason: "too_large",
      before_lines: 1000,
      after_lines: 1000,
    });
    expect(runArtifactSummary(artifacts).unavailable_count).toBe(1);
    expect(artifactDeltaLabel(artifacts[0])).toBe("1000->1000");
  });
});
