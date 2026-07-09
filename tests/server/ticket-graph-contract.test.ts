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

  it("rejects human action tickets in root PM planned delivery graphs", () => {
    const violation = validatePlannedTicketGraph([
      { key: "manual_start", type: "human_action", brief: "人工启动开发服务器", expectedArtifact: "运行中的服务" },
      { key: "accept", type: "boss_acceptance", brief: "验收", expectedArtifact: "验收结论", dependsOn: ["manual_start"] }
    ]);

    expect(violation?.reason).toContain("human_action");
    expect(violation?.reason).toContain("运行时边界");
  });

  it("rejects unknown ticket types instead of guessing implementation", () => {
    const violation = validatePlannedTicketGraph([
      { key: "research", type: "market_research", brief: "调研", expectedArtifact: "调研报告" },
      { key: "qa", type: "qa", brief: "测试", expectedArtifact: "测试报告", dependsOn: ["research"] },
      { key: "accept", type: "boss_acceptance", brief: "验收", expectedArtifact: "验收结论", dependsOn: ["qa"] }
    ]);

    expect(violation?.reason).toContain("未知工单类型");
    expect(violation?.reason).toContain("market_research");
  });

  it("accepts common model field aliases for ticket type and dependencies", () => {
    const violation = validatePlannedTicketGraph([
      { id: "qa_verify", ticket_type: "qa", title: "QA验证", expectedArtifact: "测试报告" },
      { id: "accept", ticket_type: "boss_acceptance", title: "老板验收", expectedArtifact: "验收结论", depends_on: ["qa_verify"] }
    ]);

    expect(violation).toBeUndefined();
  });

  it("extracts ticketGraph from common model response envelopes", () => {
    expect(plannedTicketItems({ ticketGraph: { tickets: [{ key: "dev", type: "implementation" }] } })).toHaveLength(1);
    expect(plannedTicketItems({ flow: { tickets: [{ key: "qa", type: "qa" }] } })).toHaveLength(1);
    expect(plannedTicketItems({ ticketGraph: [{ key: "accept", type: "boss_acceptance" }] })).toHaveLength(1);
  });
});
