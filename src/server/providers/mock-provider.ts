import type { AgentModelProvider, AgentModelTurnInput, AgentTurnResult } from "./types.js";

export class MockProvider implements AgentModelProvider {
  name = "mock" as const;

  async runModelTurn(input: AgentModelTurnInput): Promise<AgentTurnResult> {
    const structured = mockGoalOutput(input.prompt);
    return {
      text: JSON.stringify(structured),
      structured,
      usage: { inputTokens: 20, outputTokens: 15, totalTokens: 35 },
      events: [{ type: "text", text: JSON.stringify(structured) }],
    };
  }
}

function mockGoalOutput(prompt: string): Record<string, unknown> {
  if (prompt.includes("输出契约：ticket-graph-v2")) {
    return {
      goalResolution: {
        status: "completed",
        summary: "已形成执行工单 DAG",
        evidence: [],
        domainOutcome: {
          result: { plan: "实现、质量检查、验收" },
          graph: {
            schemaVersion: 2,
            nodes: [
              node("implementation", "开发执行", "实现目标并产生真实交付物", ["delivery:implement"], "delivery-v1"),
              node("qa", "质量检查", "验证交付物和成功标准", ["delivery:verify"], "qa-report-v1"),
              node("acceptance", "最终验收", "依据目标和 QA 证据验收", ["delivery:accept"], "acceptance-v1"),
            ],
            dependencyEdges: [
              { fromKey: "implementation", toKey: "qa" },
              { fromKey: "qa", toKey: "acceptance" },
            ],
          },
          completionPolicy: {
            requiredTerminalKeys: ["acceptance"],
            failurePolicy: "require_resolution",
            blockedPolicy: "wait",
          },
        },
      },
    };
  }
  return {
    goalResolution: {
      status: "completed",
      summary: "模拟 Agent 已完成当前目标",
      evidence: [],
      domainOutcome: { ok: true },
    },
  };
}

function node(key: string, title: string, objective: string, requiredCapabilities: string[], schemaRef: string) {
  return {
    key,
    title,
    objective,
    successCriteria: [`${title}达到验收标准`],
    assignment: { requiredCapabilities },
    outputContract: { schemaRef },
  };
}
