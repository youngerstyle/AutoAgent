import type { AgentModelProvider, AgentTurnInput, AgentTurnResult } from "./types.js";
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
}

function mockStructuredOutput(input: AgentTurnInput): Record<string, unknown> {
  if (input.role === "boss" && input.assignmentType === "boss_intake") {
    return { ok: true, summary: "目标可执行", next: "pm_plan" };
  }
  if (input.role === "pm") {
    return { plan: ["明确范围", "开发实现", "验证交付"], next: "architect_plan" };
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
