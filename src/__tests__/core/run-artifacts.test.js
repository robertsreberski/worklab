import { describe, expect, it } from "vitest";
import {
  aggregateRunArtifacts,
  formatHunkRanges,
  formatTaskArtifactsForPrompt,
  loadTaskArtifacts,
} from "../../core/run-artifacts.js";
import { makeTestDb } from "../helpers/test-db.js";

function fileResult(path, stats = {}) {
  return {
    type: "user",
    message: {
      content: [{
        type: "tool_result",
        tool_use_id: `file-${path}`,
        content: {
          status: "completed",
          changes: [{ path, kind: "update", line_stats: stats }],
        },
      }],
    },
  };
}

describe("core run artifacts", () => {
  it("aggregates task artifacts across run outcomes", () => {
    const artifacts = aggregateRunArtifacts([
      {
        id: "run-failed",
        started_at: 1000,
        ended_at: 1500,
        artifacts: [{
          path: "src/a.js",
          kind: "update",
          status: "completed",
          added_lines: 2,
          removed_lines: 1,
          has_line_delta: true,
          run_ids: ["run-failed"],
          first_run_id: "run-failed",
          last_run_id: "run-failed",
          first_seen_at: 1500,
          last_seen_at: 1500,
        }],
      },
      {
        id: "run-complete",
        started_at: 2000,
        ended_at: 2500,
        artifacts: [{
          path: "src/a.js",
          kind: "update",
          status: "completed",
          added_lines: 1,
          removed_lines: 0,
          has_line_delta: true,
          run_ids: ["run-complete"],
          first_run_id: "run-complete",
          last_run_id: "run-complete",
          first_seen_at: 2500,
          last_seen_at: 2500,
        }],
      },
    ]);

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      path: "src/a.js",
      added_lines: 3,
      removed_lines: 1,
      first_run_id: "run-failed",
      last_run_id: "run-complete",
      run_ids: ["run-failed", "run-complete"],
    });
  });

  it("loads prior task artifacts from completed log fallback and excludes current runs", () => {
    const db = makeTestDb();
    const now = Date.now();
    db.prepare("INSERT INTO tasks (id, title, created_at, updated_at) VALUES ('task-1', 'Artifacts', ?, ?)").run(now, now);
    db.prepare(`
      INSERT INTO task_runs (id, task_id, mode, agent_name, started_at, ended_at, status, process_status)
      VALUES ('run-prior', 'task-1', 'execute', 'owner', ?, ?, 'complete', 'succeeded')
    `).run(now - 2000, now - 1000);
    db.prepare(`
      INSERT INTO task_runs (id, task_id, mode, agent_name, started_at, status, process_status)
      VALUES ('run-current', 'task-1', 'execute', 'owner', ?, 'running', 'running')
    `).run(now);
    db.prepare("INSERT INTO agent_logs (id, task_run_id, events, status, created_at) VALUES ('log-prior', 'run-prior', ?, 'complete', ?)")
      .run(JSON.stringify([fileResult("src/prior.js", { added_lines: 4, removed_lines: 1 })]), now - 1000);
    db.prepare("INSERT INTO agent_logs (id, task_run_id, events, status, created_at) VALUES ('log-current', 'run-current', ?, 'running', ?)")
      .run(JSON.stringify([fileResult("src/current.js", { added_lines: 10, removed_lines: 0 })]), now);

    const loaded = loadTaskArtifacts(db, "task-1", { excludeRunId: "run-current" });

    expect(loaded.summary).toMatchObject({ files: 1, added_lines: 4, removed_lines: 1, run_count: 1 });
    expect(loaded.artifacts.map((artifact) => artifact.path)).toEqual(["src/prior.js"]);
  });

  it("formats compact artifact context for prompts", () => {
    const body = formatTaskArtifactsForPrompt({
      artifacts: [{
        path: "src/a.js",
        display_path: "src/a.js",
        added_lines: 2,
        removed_lines: 1,
        has_line_delta: true,
        last_run_id: "run-1",
        run_ids: ["run-1"],
      }],
      summary: { files: 1, added_lines: 2, removed_lines: 1, run_count: 1 },
    });

    expect(body).toContain("Task-wide file changes before this run: 1 file, +2 -1 across 1 run.");
    expect(body).toContain("- `src/a.js` (+2 -1, last run `run-1`)");
  });

  it("replaces older-run hunks with the latest run's ranges, but keeps cumulative line counts", () => {
    const artifacts = aggregateRunArtifacts([
      {
        id: "run-old",
        started_at: 1000,
        ended_at: 1500,
        artifacts: [{
          path: "src/a.js",
          kind: "update",
          status: "completed",
          added_lines: 4,
          removed_lines: 2,
          has_line_delta: true,
          hunks: [{ start: 10, end: 12 }, { start: 40, end: 41 }],
          run_ids: ["run-old"],
          first_run_id: "run-old",
          last_run_id: "run-old",
          first_seen_at: 1500,
          last_seen_at: 1500,
        }],
      },
      {
        id: "run-new",
        started_at: 2000,
        ended_at: 2500,
        artifacts: [{
          path: "src/a.js",
          kind: "update",
          status: "completed",
          added_lines: 3,
          removed_lines: 1,
          has_line_delta: true,
          hunks: [{ start: 5, end: 7 }],
          run_ids: ["run-new"],
          first_run_id: "run-new",
          last_run_id: "run-new",
          first_seen_at: 2500,
          last_seen_at: 2500,
        }],
      },
    ]);

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      added_lines: 7,
      removed_lines: 3,
      last_run_id: "run-new",
    });
    expect(artifacts[0].hunks).toEqual([{ start: 5, end: 7 }]);
  });

  it("renders compacted line ranges in the prompt with new file / deleted markers", () => {
    const body = formatTaskArtifactsForPrompt({
      artifacts: [
        {
          path: "src/a.js",
          display_path: "src/a.js",
          kind: "update",
          status: "completed",
          added_lines: 12,
          removed_lines: 5,
          has_line_delta: true,
          hunks: [{ start: 45, end: 50 }, { start: 52, end: 55 }, { start: 92, end: 92 }],
          last_run_id: "run-1",
          last_seen_at: 1000,
          run_ids: ["run-1"],
        },
        {
          path: "src/new.js",
          display_path: "src/new.js",
          kind: "add",
          status: "completed",
          added_lines: 25,
          removed_lines: 0,
          has_line_delta: true,
          hunks: [{ start: 1, end: 25 }],
          last_run_id: "run-1",
          last_seen_at: 1100,
          run_ids: ["run-1"],
        },
        {
          path: "src/old.js",
          display_path: "src/old.js",
          kind: "delete",
          status: "completed",
          added_lines: 0,
          removed_lines: 30,
          has_line_delta: true,
          hunks: [],
          last_run_id: "run-1",
          last_seen_at: 1200,
          run_ids: ["run-1"],
        },
      ],
      summary: { files: 3, added_lines: 37, removed_lines: 35, run_count: 1 },
    });

    expect(body).toContain("- `src/a.js` (+12 -5, lines 45-55, 92, last run `run-1`)");
    expect(body).toContain("- `src/new.js` (+25 -0, new file, last run `run-1`)");
    expect(body).toContain("- `src/old.js` (+0 -30, deleted, last run `run-1`)");
  });

  it("collapses many ranges with the +K more suffix", () => {
    const hunks = Array.from({ length: 9 }, (_, i) => ({ start: 100 + i * 10, end: 100 + i * 10 }));
    expect(formatHunkRanges(hunks)).toBe("lines 100, 110, 120, 130, 140, 150, +3 more");
  });

  it("treats stored artifacts without hunks as count-only (backward compat)", () => {
    const artifacts = aggregateRunArtifacts([
      {
        id: "run-legacy",
        started_at: 1000,
        ended_at: 1500,
        artifacts: [{
          path: "src/legacy.js",
          kind: "update",
          status: "completed",
          added_lines: 7,
          removed_lines: 3,
          has_line_delta: true,
          run_ids: ["run-legacy"],
          first_run_id: "run-legacy",
          last_run_id: "run-legacy",
          first_seen_at: 1500,
          last_seen_at: 1500,
        }],
      },
    ]);
    expect(artifacts[0].hunks).toEqual([]);
    const body = formatTaskArtifactsForPrompt({
      artifacts,
      summary: { files: 1, added_lines: 7, removed_lines: 3, run_count: 1 },
    });
    expect(body).toContain("- `src/legacy.js` (+7 -3, last run `run-legacy`)");
  });
});
