import type { AgentModelProvider, AgentModelTurnInput, AgentModelTurnResult } from "./types.js";

export class MockProvider implements AgentModelProvider {
  name = "mock" as const;

  async runModelTurn(input: AgentModelTurnInput): Promise<AgentModelTurnResult> {
    if (!input.tools.some((tool) => tool.name === "goal_resolution")) {
      return {
        items: [{ type: "assistant_message", content: "已收到并处理当前消息。" }],
        usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
      };
    }
    return {
      items: [{
        type: "tool_call",
        callId: `mock-goal-${input.history.length}`,
        name: "goal_resolution",
        arguments: mockGoalResolution(input.instructions),
      }],
      usage: { inputTokens: 20, outputTokens: 15, totalTokens: 35 },
    };
  }
}

function mockGoalResolution(instructions: string): Record<string, unknown> {
  if (instructions.includes("plan-change-set-v3")) {
    const sourceTicketId = currentTicketId(instructions);
    return {
      status: "completed",
      evidence: [],
      criterionResults: completedCriteria(instructions),
      residualRisks: [],
      domainOutcome: {
        summary: "已形成执行工单 DAG",
        result: { plan: "实现、质量检查、验收" },
        change: {
          additions: [
            node("implementation", "开发执行", "实现目标并产生真实交付物", ["delivery:implement"], "delivery-v1"),
            node("qa", "质量检查", "验证交付物和成功标准", ["delivery:verify"], "qa-report-v1"),
            node("acceptance", "最终验收", "依据目标和 QA 证据验收", ["delivery:accept"], "acceptance-v1"),
          ],
          dependencyAdditions: [
            { from: { ticketId: sourceTicketId }, to: { clientRef: "implementation" } },
            { from: { clientRef: "implementation" }, to: { clientRef: "qa" } },
            { from: { clientRef: "qa" }, to: { clientRef: "acceptance" } },
          ],
          cancelTicketIds: [],
          requiredTerminalRefs: [{ clientRef: "acceptance" }],
        },
      },
    };
  }
  return {
    status: "completed",
    evidence: [],
    criterionResults: completedCriteria(instructions),
    residualRisks: [],
    domainOutcome: { summary: "模拟 Agent 已完成当前目标", ok: true },
  };
}

function completedCriteria(instructions: string) {
  const block = instructions.match(/成功标准：\r?\n((?:- [^\r\n]*(?:\r?\n|$))+)/)?.[1] ?? "";
  const count = block.split(/\r?\n/).filter((line) => line.startsWith("- ")).length;
  return Array.from({ length: count }, (_, criterionIndex) => ({ criterionIndex, status: "satisfied", evidence: [] }));
}

function currentTicketId(instructions: string): string {
  const match = instructions.match(/^- ticket:\s*([0-9a-f-]{36})\s*$/im);
  if (!match) throw new Error("Mock planning turn is missing its current Ticket context");
  return match[1];
}

function node(clientRef: string, title: string, objective: string, requiredCapabilities: string[], schemaRef: string) {
  return {
    clientRef,
    title,
    objective,
    successCriteria: [`${title}达到验收标准`],
    assignment: { requiredCapabilities },
    outputContract: { schemaRef },
  };
}
