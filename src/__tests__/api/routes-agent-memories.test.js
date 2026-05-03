import { describe, expect, it } from "vitest";
import { makeTestServer } from "../helpers/test-server.js";
import { recordAgentMemoryCandidates } from "../../core/agent-learning.js";

function seedAgent(db, name = "coder") {
  const now = 1700000000000;
  db.prepare(`
    INSERT INTO agents (name, display_name, sdk, model, created_at, updated_at)
    VALUES (?, ?, 'claude', 'claude:claude-sonnet-4-6', ?, ?)
  `).run(name, name, now, now);
}

describe("agent learning memory routes", () => {
  it("lists and updates structured memories for an agent", async () => {
    const { agent, db } = makeTestServer();
    seedAgent(db);
    const recorded = recordAgentMemoryCandidates(db, {
      agentName: "coder",
      autoApproveThreshold: 0.95,
      candidates: [
        { kind: "procedure", content: "Review API contracts before UI changes.", confidence: 0.8, evidence: "Run r1" },
      ],
    });

    const list = await agent.get("/api/agents/coder/memories").expect(200);
    expect(list.body.memories).toHaveLength(1);
    expect(list.body.memories[0]).toMatchObject({
      id: recorded.memories[0].id,
      status: "draft",
      content: "Review API contracts before UI changes.",
    });

    const patched = await agent
      .patch(`/api/agents/coder/memories/${recorded.memories[0].id}`)
      .send({ status: "approved", evidence: "Human approved." })
      .expect(200);
    expect(patched.body.memory).toMatchObject({
      status: "approved",
      evidence: "Human approved.",
    });
  });

  it("rejects memory operations for missing agents and invalid statuses", async () => {
    const { agent, db } = makeTestServer();
    seedAgent(db);
    const recorded = recordAgentMemoryCandidates(db, {
      agentName: "coder",
      candidates: [{ kind: "fact", content: "Valid memory.", confidence: 1 }],
    });

    await agent.get("/api/agents/missing/memories").expect(404);
    await agent
      .patch(`/api/agents/coder/memories/${recorded.memories[0].id}`)
      .send({ status: "published" })
      .expect(400);
  });
});
