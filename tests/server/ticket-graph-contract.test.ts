import { describe, expect, it } from "vitest";
import { plannedTicketItems, validatePlannedTicketGraph } from "../../src/server/mission/ticket-graph-contract";

describe("TicketGraphContract", () => {
  it("accepts a simple software delivery flow through development, QA, and boss acceptance", () => {
    const violation = validatePlannedTicketGraph([
      { key: "dev", type: "implementation", brief: "实现", expectedArtifact: "交付物" },
      { key: "qa", type: "qa", brief: "测试", expectedArtifact: "测试报告", dependsOn: ["dev"] },
      { key: "accept", type: "boss_acceptance", brief: "验收", expectedArtifact: "验收结论", dependsOn: ["qa"] }
    ]);

    expect(violation).toBeUndefined();
  });

  it("rejects implementation-only graphs because software delivery must reach QA and boss acceptance", () => {
    const violation = validatePlannedTicketGraph([
      { key: "dev", type: "implementation", brief: "启动服务", expectedArtifact: "运行中的服务" }
    ]);

    expect(violation?.reason).toContain("老板验收");
  });

  it("rejects completed records inside a planned ticket graph", () => {
    const violation = validatePlannedTicketGraph([
      { key: "pm_note", type: "pm_plan", status: "completed", brief: "已写计划", expectedArtifact: "计划文档" },
      { key: "dev", type: "implementation", brief: "实现", expectedArtifact: "交付物", dependsOn: ["pm_note"] },
      { key: "qa", type: "qa", brief: "测试", expectedArtifact: "测试报告", dependsOn: ["dev"] },
      { key: "accept", type: "boss_acceptance", brief: "验收", expectedArtifact: "验收结论", dependsOn: ["qa"] }
    ]);

    expect(violation?.reason).toContain("待执行工单");
  });

  it("extracts ticketGraph from common model response envelopes", () => {
    expect(plannedTicketItems({ ticketGraph: { tickets: [{ key: "dev", type: "implementation" }] } })).toHaveLength(1);
    expect(plannedTicketItems({ flow: { tickets: [{ key: "qa", type: "qa" }] } })).toHaveLength(1);
    expect(plannedTicketItems({ ticketGraph: [{ key: "accept", type: "boss_acceptance" }] })).toHaveLength(1);
  });
});
