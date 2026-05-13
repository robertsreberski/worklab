import { cpSync, existsSync, readdirSync, readFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { insertAgent } from "./db/queries/agents.js";

export function seedDataFromTemplate({ templateDir, dataDir }) {
  if (existsSync(dataDir) && readdirSync(dataDir).length > 0) return { seeded: false };
  if (!existsSync(templateDir)) return { seeded: false, reason: "no-template" };
  mkdirSync(dataDir, { recursive: true });
  cpSync(templateDir, dataDir, { recursive: true });
  return { seeded: true };
}

// Seed the planner / executor / reviewer trio on first boot. Idempotent —
// any agent with the same name already in the DB is left alone, so re-running
// boot doesn't clobber user-customized rows. Reads JSON definitions from
// `data-template/agents/_seed/` so operators can fork the file without
// touching code.
export function seedDefaultAgents({ db, templateDir, logger } = {}) {
  if (!db || !templateDir) return { seeded: 0 };
  const seedDir = join(templateDir, "agents", "_seed");
  if (!existsSync(seedDir)) return { seeded: 0, reason: "no-seed-dir" };
  let entries;
  try {
    entries = readdirSync(seedDir).filter((name) => name.endsWith(".json"));
  } catch {
    return { seeded: 0, reason: "no-seed-dir" };
  }
  const existing = new Set(
    db.prepare("SELECT name FROM agents").all().map((row) => row.name),
  );
  let seeded = 0;
  const skipped = [];
  for (const filename of entries) {
    const path = join(seedDir, filename);
    try {
      if (!statSync(path).isFile()) continue;
      const raw = readFileSync(path, "utf8");
      const def = JSON.parse(raw);
      if (!def.name || typeof def.name !== "string") continue;
      if (existing.has(def.name)) {
        skipped.push(def.name);
        continue;
      }
      const now = Date.now();
      insertAgent(db, {
        name: def.name,
        displayName: def.display_name || def.name,
        description: def.description || "",
        sdk: def.sdk,
        model: def.model,
        effort: def.effort || "medium",
        contextWindow: def.context_window || "default",
        fastMode: def.fast_mode !== false,
        instructions: def.instructions || "",
        skillsAllowlistJson: JSON.stringify(def.skills_allowlist || []),
        skillsAllowlistMode: def.skills_allowlist_mode || "all",
        mcpAllowlistJson: JSON.stringify(def.mcp_allowlist || []),
        mcpAllowlistMode: def.mcp_allowlist_mode || "all",
        builtinAllowlistJson: JSON.stringify(def.builtin_allowlist || []),
        builtinAllowlistMode: def.builtin_allowlist_mode || "all",
        allowSelfReview: def.allow_self_review ?? 1,
        browserToolsReviewOnly: def.browser_tools_review_only ?? 0,
        executionMode: def.execution_mode || "sdk",
        enabled: def.enabled ?? 1,
        createdAt: now,
        updatedAt: now,
      });
      seeded += 1;
    } catch (err) {
      logger?.warn?.({ err: err.message, filename }, "default-agent seed failed");
    }
  }
  return { seeded, skipped };
}
