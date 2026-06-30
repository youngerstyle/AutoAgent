import type { AgentModelProvider, AgentTurnInput, AgentTurnResult } from "./types.js";

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
        { type: "status", text: `${input.role} started ${input.assignmentType}` },
        { type: "text", text },
        { type: "usage", usage: { inputTokens: 20, outputTokens: 30, totalTokens: 50 } }
      ]
    };
  }
}

function mockStructuredOutput(input: AgentTurnInput): Record<string, unknown> {
  if (input.role === "boss" && input.assignmentType === "boss_intake") {
    return { ok: true, summary: "Goal is actionable", next: "pm_plan" };
  }
  if (input.role === "pm") {
    return { plan: ["Define scope", "Implement", "Verify"], next: "architect_plan" };
  }
  if (input.role === "architect") {
    const goal = String(input.context?.goal ?? "");
    const needsSpecialist = /security|auth|c#|csharp/i.test(goal);
    return {
      architecture: "Use a minimal local web app with event-sourced runtime state",
      needsSpecialist,
      capabilityGap: needsSpecialist ? "Security/Auth specialist" : undefined,
      next: needsSpecialist ? "recruit" : "implementation"
    };
  }
  if (input.role === "dev" || input.role === "specialist") {
    return {
      artifact: "implementation-report.md",
      toolIntents: [
        { tool: "writeFile", path: "AUTOAGENT_RESULT.md", content: `Completed: ${input.prompt}\n` }
      ],
      next: "qa"
    };
  }
  if (input.role === "qa") {
    return { passed: true, report: "Mock QA passed", next: "boss_acceptance" };
  }
  return { accepted: true, summary: "Accepted", next: "completed" };
}
