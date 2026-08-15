import { describe, expect, it } from "vitest";
import { matchesEvolutionOwner, resolveEvolutionLayers } from "../../src/server/evolution/runtime-projection.js";
import type { WorkspaceAgent } from "../../src/shared/types.js";

describe("Evolution owner scope resolution", () => {
  const agent = { id: "instance-a", workspaceId: "workspace-a", profileId: "profile-a", roleInWorkspace: "dev", agentDir: "agents/a", status: "idle" } satisfies WorkspaceAgent;

  it("keeps agent-project learning on the same stable Agent and project instance", () => {
    const scope = { ownerLevel: "agent_project" as const, workspaceId: "workspace-a", profileId: "profile-a" };
    expect(matchesEvolutionOwner(scope, "workspace-a", agent)).toBe(true);
    expect(matchesEvolutionOwner(scope, "workspace-b", { ...agent, workspaceId: "workspace-b" })).toBe(false);
    expect(matchesEvolutionOwner(scope, "workspace-a", { ...agent, id: "instance-b", profileId: "profile-b" })).toBe(false);
  });

  it("lets an explicitly promoted Agent scope follow profileId but not a same-role peer", () => {
    const scope = { ownerLevel: "agent" as const, workspaceId: "workspace-a", profileId: "profile-a" };
    expect(matchesEvolutionOwner(scope, "workspace-b", { ...agent, id: "instance-in-b", workspaceId: "workspace-b" })).toBe(true);
    expect(matchesEvolutionOwner(scope, "workspace-a", { ...agent, id: "peer", profileId: "profile-b" })).toBe(false);
  });

  it("treats legacy releases as project scope and recognizes explicit project/company scopes", () => {
    expect(matchesEvolutionOwner({ workspaceId: "workspace-a" }, "workspace-a", agent)).toBe(true);
    expect(matchesEvolutionOwner({ workspaceId: "workspace-a" }, "workspace-b", { ...agent, workspaceId: "workspace-b" })).toBe(false);
    expect(matchesEvolutionOwner({ ownerLevel: "project", workspaceId: "workspace-a" }, "workspace-a", agent)).toBe(true);
    expect(matchesEvolutionOwner({ ownerLevel: "company", workspaceId: "origin-workspace" }, "workspace-b", agent)).toBe(true);
  });

  it("resolves company < agent < project < agent-project and only lets Canary win within one layer", () => {
    const item = (ownerLevel: "company" | "agent" | "project" | "agent_project", stage: "production" | "canary", releaseId: string, generation = 1) => ({ target: "shared-rule", ownerLevel, stage, releaseId, generation });
    expect(resolveEvolutionLayers([
      item("company", "canary", "company-canary"),
      item("agent", "production", "agent-production"),
      item("project", "production", "project-production"),
      item("agent_project", "production", "agent-project-production"),
    ], (value) => value.target)).toEqual([expect.objectContaining({ releaseId: "agent-project-production" })]);
    expect(resolveEvolutionLayers([
      item("project", "production", "project-production", 3),
      item("project", "canary", "project-canary", 1),
    ], (value) => value.target)).toEqual([expect.objectContaining({ releaseId: "project-canary" })]);
    expect(resolveEvolutionLayers([
      item("agent", "canary", "agent-canary"),
      item("project", "production", "project-production"),
    ], (value) => value.target)).toEqual([expect.objectContaining({ releaseId: "project-production" })]);
  });
});
