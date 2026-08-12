import { describe, expect, it } from "vitest";
import { PlanDefinitionRegistry } from "../../src/server/product/plan-definition-registry.js";
import { createMinimalTeamPlanDefinition } from "../../src/server/product/plan-template.js";
import type { PlanPolicyRef } from "../../src/shared/contracts/ticket-engine.js";

describe("versioned plan product data", () => {
  it("defines intake then planning without human or downstream topology in manager code", () => {
    const definition = createMinimalTeamPlanDefinition(policyRef, "构建坦克大战");
    expect(JSON.stringify(definition)).not.toContain("构建坦克大战");
    expect(definition.initialChange.additions[0]?.objective).toContain("不要求 human 撰写完整规格");
    expect(definition.initialChange.additions[0]?.successCriteria).toEqual(expect.arrayContaining([
      expect.stringContaining("可逆的不确定项不阻塞交接"),
      expect.stringContaining("不可替代输入时才阻塞"),
      expect.stringContaining("只提交正式 Mission 基线"),
    ]));
    expect(definition.initialChange.additions.map((node) => node.clientRef)).toEqual(["intake", "planning"]);
    expect(definition.initialChange.additions.map((node) => node.contextPolicy?.includeOriginalRequest ?? false)).toEqual([true, true]);
    expect(definition.initialChange.additions[1]?.objective).toContain("需求接收工单的正式交付");
    expect(definition.initialChange.additions[1]?.successCriteria).toEqual(expect.arrayContaining([
      expect.stringContaining("语义降级"),
      expect.stringContaining("新增实际执行工单"),
      expect.stringContaining("不能把启动骨架"),
      expect.stringContaining("多个增量"),
    ]));
    expect(definition.initialChange.additions.map((node) => node.assignment.requiredCapabilities)).toEqual([
      ["mission:intake"],
      ["plan:plan"],
    ]);
    expect(definition.initialChange.dependencyAdditions).toEqual([{ from: { clientRef: "intake" }, to: { clientRef: "planning" } }]);
    expect(JSON.stringify(definition)).not.toContain("human_action");
  });

  it("declares the intake handoff as the Mission baseline", () => {
    const definition = createMinimalTeamPlanDefinition(policyRef, "build the agreed product");
    const [intake] = definition.initialChange.additions;

    expect(intake).toMatchObject({
      outputContract: { schemaRef: "mission-baseline-v2" },
      contextPolicy: {
        includeOriginalRequest: true,
        establishesMissionBaseline: true,
      },
    });
  });

  it("resolves an immutable version before Mission start", async () => {
    const registry = new PlanDefinitionRegistry(policyRef);
    await expect(registry.resolve({ templateId: "minimal-team", templateVersion: 8, teamBindingId: "team-a", objective: "构建坦克大战" }))
      .resolves.toMatchObject({ teamBindingId: "team-a", planDefinition: { definitionVersion: 8 } });
    await expect(registry.resolve({ templateId: "minimal-team", templateVersion: 6, teamBindingId: "team-a", objective: "构建坦克大战" }))
      .rejects.toThrow("version does not exist");
  });
});

const policyRef: PlanPolicyRef = { policyId: "minimal-team", policyVersion: 1, contentHash: "hash" };
