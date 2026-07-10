import type { AgentModelProvider, AgentModelTurnInput, AgentTurnInput, AgentTurnResult } from "./types.js";
import { assignmentLabel, roleLabel } from "../../shared/labels.js";

export class MockProvider implements AgentModelProvider {
  name = "mock" as const;

  async runAgentTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
    const structured = mockStructuredOutput(input);
    const text = JSON.stringify(structured);
    return {
      text,
      structured,
      usage: { inputTokens: 20, outputTokens: 30, totalTokens: 50 },
      events: [
        { type: "status", text: `${roleLabel(input.role)}开始${assignmentLabel(input.assignmentType)}` },
        { type: "text", text },
        { type: "usage", usage: { inputTokens: 20, outputTokens: 30, totalTokens: 50 } }
      ]
    };
  }

  async runModelTurn(input: AgentModelTurnInput): Promise<AgentTurnResult> {
    const structured = { message: "模拟 Agent turn 已完成，目标保持活动。" };
    return {
      text: JSON.stringify(structured),
      structured,
      usage: { inputTokens: 20, outputTokens: 15, totalTokens: 35 },
      events: [{ type: "text", text: JSON.stringify(structured) }],
    };
  }
}

function mockStructuredOutput(input: AgentTurnInput): Record<string, unknown> {
  if (input.role === "boss" && input.assignmentType === "boss_intake") {
    return { ok: true, summary: "目标可执行", next: "pm_plan" };
  }
  if (input.role === "pm") {
    return {
      plan: "默认按架构、开发、质量检查、老板验收推进。",
      ticketGraph: [
        {
          key: "architecture",
          type: "architect_plan",
          brief: "判断架构方案、技术路径和能力缺口",
          expectedArtifact: "技术方案",
          targetRole: "architect"
        },
        {
          key: "implementation",
          type: "implementation",
          brief: "按计划开发并产出交付物",
          expectedArtifact: "真实项目文件或可运行交付物",
          targetRole: "dev",
          dependsOn: ["architecture"]
        },
        {
          key: "qa",
          type: "qa",
          brief: "验证实现并给出通过或失败结论",
          expectedArtifact: "质量检查结论",
          targetRole: "qa",
          dependsOn: ["implementation"]
        },
        {
          key: "acceptance",
          type: "boss_acceptance",
          brief: "验收已通过质量检查的交付物",
          expectedArtifact: "验收结论",
          targetRole: "boss",
          dependsOn: ["qa"]
        }
      ]
    };
  }
  if (input.role === "architect") {
    const goal = String(input.context?.goal ?? "");
    const needsSpecialist = /security|auth|c#|csharp/i.test(goal);
    return {
      architecture: "使用最小本地 Web 应用，并用事件流记录运行状态",
      needsSpecialist,
      capabilityGap: needsSpecialist ? "安全/认证" : undefined,
      next: needsSpecialist ? "recruit" : "implementation"
    };
  }
  if (input.role === "dev" || input.role === "specialist") {
    return {
      artifact: "implementation-report.md",
      toolIntents: [
        { tool: "writeFile", path: "AUTOAGENT_RESULT.md", content: `已完成：${input.prompt}\n` }
      ],
      next: "qa"
    };
  }
  if (input.role === "qa") {
    return { passed: true, report: "模拟测试通过", next: "boss_acceptance" };
  }
  return { accepted: true, summary: "已验收", next: "completed" };
}
