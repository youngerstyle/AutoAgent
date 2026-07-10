import { describe, expect, it } from "vitest";
import { WorkflowDefinitionRegistry } from "../../src/server/product/workflow-definition-registry.js";
import { createMinimalTeamWorkflowDefinition } from "../../src/server/product/workflow-template.js";
import type { WorkflowPolicyRef } from "../../src/shared/contracts/ticket-engine.js";

describe("versioned workflow product data", () => {
  it("defines intake then planning without human or downstream topology in manager code", () => {
    const definition = createMinimalTeamWorkflowDefinition(policyRef, "构建坦克大战");
    expect(definition.initialGraph.nodes[0]?.objective).toContain("构建坦克大战");
    expect(definition.initialGraph.nodes[0]?.objective).toContain("不要求 human 撰写完整规格");
    expect(definition.initialGraph.nodes[0]?.successCriteria).toEqual(expect.arrayContaining([
      expect.stringContaining("可逆的不确定项不阻塞交接"),
      expect.stringContaining("不可替代输入时才阻塞"),
    ]));
    expect(definition.initialGraph.nodes.map((node) => node.key)).toEqual(["intake", "planning"]);
    expect(definition.initialGraph.nodes.map((node) => node.assignment.requiredCapabilities)).toEqual([
      ["mission:intake"],
      ["workflow:plan"],
    ]);
    expect(definition.initialGraph.dependencyEdges).toEqual([{ fromKey: "intake", toKey: "planning" }]);
    expect(JSON.stringify(definition)).not.toContain("human_action");
  });

  it("resolves an immutable version before Mission start", async () => {
    const registry = new WorkflowDefinitionRegistry(policyRef);
    await expect(registry.resolve({ templateId: "minimal-team", templateVersion: 1, teamBindingId: "team-a", objective: "构建坦克大战" }))
      .resolves.toMatchObject({ teamBindingId: "team-a", workflowDefinition: { definitionVersion: 1 } });
    await expect(registry.resolve({ templateId: "minimal-team", templateVersion: 2, teamBindingId: "team-a", objective: "构建坦克大战" }))
      .rejects.toThrow("version does not exist");
  });
});

const policyRef: WorkflowPolicyRef = { policyId: "minimal-team", policyVersion: 1, contentHash: "hash" };
