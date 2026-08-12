import { describe, expect, it } from "vitest";
import { MockProvider } from "../../src/server/providers/mock-provider.js";

describe("MockProvider current Ticket contract", () => {
  it("does not claim real delivery completed when only the mock provider is available", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousAllowFlag = process.env.AUTOAGENT_ALLOW_MOCK_DELIVERY;
    process.env.NODE_ENV = "development";
    delete process.env.AUTOAGENT_ALLOW_MOCK_DELIVERY;

    try {
      const result = await runMock("[current-ticket]\noutput-schema=delivery-v1\nsettle-mission=false\n[/current-ticket]\n成功标准：\n- 形成真实交付物");
      const item = result.items[0];
      expect(item).toMatchObject({ type: "tool_call", name: "request_human_input" });
      expect(toolArguments(result)).toMatchObject({
        kind: "credential",
        description: expect.stringContaining("无法真实写文件"),
        details: { provider: "mock", requiredFor: "delivery-v1" },
      });
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousAllowFlag === undefined) delete process.env.AUTOAGENT_ALLOW_MOCK_DELIVERY;
      else process.env.AUTOAGENT_ALLOW_MOCK_DELIVERY = previousAllowFlag;
    }
  });

  it("uses the latest Ticket metadata instead of historical settleMission text", async () => {
    const assuranceTicketId = "68f8882f-9598-4b8f-8d61-39df2b00f8ef";
    const workContext = {
      currentPlan: {
        missionBaseline: {
          version: 1,
          criteria: [{ criterionId: "criterion-1" }],
        },
      },
      handoffLineage: [{
        ticketId: assuranceTicketId,
        outputContract: { schemaRef: "mission-assurance-v1" },
      }],
    };
    const result = await runMock([
      "[current-ticket]\noutput-schema=mission-baseline-v1\nsettle-mission=false\n[/current-ticket]",
      "historical context: {\"settleMission\":true,\"missionBaseline\":{}}",
      "[current-ticket]\noutput-schema=acceptance-v1\nsettle-mission=true\n[/current-ticket]",
      `当前工作上下文（由 Mission Control 从 Ticket Engine 的权威状态组装，不含其他 Agent 的私有会话）：${JSON.stringify(workContext)}。currentPlan 是所有参与者共享的当前执行视图`,
    ].join("\n"));

    expect(toolArguments(result)).toMatchObject({
      domainOutcome: {
        summary: "mock acceptance",
        residualRisks: [],
      },
    });
  });

  it("keeps a current planning Ticket in planning even when history contains acceptance metadata", async () => {
    const result = await runMock([
      "[current-ticket]\noutput-schema=acceptance-v1\nsettle-mission=true\n[/current-ticket]",
      "[current-ticket]\noutput-schema=plan-intent-v1\nsettle-mission=false\n[/current-ticket]",
    ].join("\n"));

    const outcome = toolArguments(result) as {
      domainOutcome: { intent: { todos: Array<{ kind: string }> } };
    };
    expect(outcome.domainOutcome.intent.todos).toEqual([
      expect.objectContaining({ kind: "implementation" }),
    ]);
  });

  it("returns only semantic work intent and no platform graph fields", async () => {
    const result = await runMock("[current-ticket]\noutput-schema=plan-intent-v1\nsettle-mission=false\n[/current-ticket]");
    const outcome = toolArguments(result) as {
      domainOutcome: Record<string, unknown>;
    };
    expect(outcome.domainOutcome).toHaveProperty("intent");
    expect(outcome.domainOutcome).not.toHaveProperty("change");
    expect(outcome.domainOutcome).not.toHaveProperty("result");
  });
});

async function runMock(instructions: string) {
  return new MockProvider().runModelTurn({
    instructions,
    history: [],
    tools: [
      { name: "goal_resolution", description: "submit", inputSchema: {} },
      { name: "request_human_input", description: "ask", inputSchema: {} },
    ],
    model: "mock",
    provider: "mock",
  });
}

function toolArguments(result: Awaited<ReturnType<MockProvider["runModelTurn"]>>) {
  const item = result.items[0];
  if (item?.type !== "tool_call") throw new Error("MockProvider did not return a tool call");
  return item.arguments;
}
