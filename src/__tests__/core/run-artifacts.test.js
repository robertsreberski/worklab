import { describe, expect, it } from "vitest";
import {
  aggregateRunArtifacts,
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
});
