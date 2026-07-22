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
  const ticket = currentTicketMetadata(instructions);
  if (ticket.outputSchema === "mission-baseline-v1" && !ticket.settleMission) {
    return {
      status: "completed",
      summary: "已建立 Mission 权威目标基线",
      evidence: [],
      criterionResults: completedCriteria(instructions),
      residualRisks: [],
      domainOutcome: {
        baseline: {
          objective: "完成 human 已明确要求的产品目标",
          successCriteria: ["真实交付物可运行并通过独立验收"],
          constraints: [], assumptions: [], exclusions: [],
        },
      },
    };
  }
  if (ticket.outputSchema === "plan-change-set-v3" && !ticket.settleMission) {
    const sourceTicketId = currentTicketId(instructions);
    return {
      status: "completed",
      summary: "已形成执行工单 DAG",
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
            { ...node("acceptance", "最终验收", "依据目标和 QA 证据验收", ["delivery:accept"], "acceptance-v1"), permissions: { settleMission: true } },
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
  if (ticket.settleMission) {
    const criterionIds = [...new Set([...instructions.matchAll(/"criterionId":"([^"]+)"/g)].map((match) => match[1]))];
    const baselineVersion = Number(instructions.match(/"missionBaseline":\{[^}]*"version":(\d+)/)?.[1] ?? 1);
    return {
      status: "completed",
      summary: "已依据 Mission 基线完成最终验收",
      evidence: [],
      criterionResults: completedCriteria(instructions),
      residualRisks: [],
      domainOutcome: {
        missionResolution: {
          baselineVersion,
          summary: "mock acceptance",
          criterionResults: criterionIds.map((criterionId) => ({
            criterionId,
            status: "satisfied",
            evidence: [{ kind: "test", ref: `mock://acceptance/${criterionId}` }],
          })),
          residualRisks: [],
        },
      },
    };
  }
  return {
    status: "completed",
    summary: "模拟 Agent 已完成当前目标",
    evidence: [],
    criterionResults: completedCriteria(instructions),
    residualRisks: [],
    domainOutcome: { summary: "模拟 Agent 已完成当前目标", ok: true },
  };
}

function currentTicketMetadata(instructions: string): { outputSchema?: string; settleMission: boolean } {
  const block = [...instructions.matchAll(/\[current-ticket\]([\s\S]*?)\[\/current-ticket\]/g)].at(-1)?.[1] ?? "";
  return {
    outputSchema: block.match(/^output-schema=(.+)$/m)?.[1]?.trim(),
    settleMission: block.match(/^settle-mission=(.+)$/m)?.[1]?.trim() === "true",
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
