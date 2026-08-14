import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentTraceStore } from "../../src/server/agent-engine/trace-store.js";
import { EvolutionStore } from "../../src/server/evolution/evolution-store.js";

describe("Evol Agent Profile runtime authority", () => {
  it("requires critical risk before provider, model, or tool policy can become an activatable Profile mutation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-profile-governance-"));
    await new AgentTraceStore(root, "agent-a").append({
      traceId: "trace-profile-authority", agentId: "agent-a", threadId: "thread-a", turnId: "turn-a",
      kind: "context", createdAt: "2026-08-14T00:00:00.000Z", data: { observed: "provider and policy mismatch" },
    });
    const store = new EvolutionStore("workspace-a", root, () => new Date("2026-08-14T00:01:00.000Z"));
    const artifactContent = JSON.stringify({
      schemaVersion: 1, id: "profile-dev", defaultProvider: "anthropic", defaultModel: "governed-model",
      defaultPolicy: { canReadWorkspace: true, canWriteWorkspace: false, canExecuteCommands: false, enabledTools: ["listFiles", "readFile"] },
    });
    const high = await store.create(input("profile-high", "high", artifactContent));
    const rejected = await store.validate({ commandId: "validate-profile-high", candidateId: high.candidateId, expectedContentHash: high.contentHash });
    expect(rejected.validation).toEqual(expect.objectContaining({ passed: false, checks: expect.arrayContaining([expect.objectContaining({ name: "agent_profile_runtime_authority", passed: false })]) }));

    const critical = await store.create(input("profile-critical", "critical", artifactContent));
    const accepted = await store.validate({ commandId: "validate-profile-critical", candidateId: critical.candidateId, expectedContentHash: critical.contentHash });
    expect(accepted.validation).toEqual(expect.objectContaining({ passed: true, checks: expect.arrayContaining([expect.objectContaining({ name: "agent_profile_runtime_authority", passed: true })]) }));
  });
});

function input(commandId: string, riskLevel: "high" | "critical", artifactContent: string) {
  return {
    commandId, kind: "agent_profile" as const, target: "profile-dev", title: "Governed runtime profile",
    rationale: "Observed runtime behavior requires an explicitly governed provider and least-privilege tool policy.",
    hypothesis: "The governed profile will improve task success without increasing policy or safety violations.", artifactContent,
    sourceRefs: [{ kind: "trace" as const, ref: "trace-profile-authority", workspaceId: "workspace-a", agentId: "agent-a" }],
    scope: { workspaceId: "workspace-a" }, expectedMetrics: [{ metric: "task_success_rate", direction: "increase" as const }],
    riskLevel, proposedBy: { type: "agent" as const, id: "agent-a" },
  };
}
