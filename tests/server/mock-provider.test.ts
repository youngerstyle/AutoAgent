import { describe, expect, it } from "vitest";
import { MockProvider } from "../../src/server/providers/mock-provider.js";

describe("MockProvider current Ticket contract", () => {
  it("uses the latest Ticket metadata instead of historical settleMission text", async () => {
    const result = await runMock([
      "[current-ticket]\noutput-schema=mission-baseline-v1\nsettle-mission=false\n[/current-ticket]",
      "historical context: {\"settleMission\":true,\"missionBaseline\":{}}",
      "[current-ticket]\noutput-schema=acceptance-v1\nsettle-mission=true\n[/current-ticket]",
      "current context: {\"criterionId\":\"criterion-1\",\"missionBaseline\":{\"version\":1}}",
    ].join("\n"));

    expect(toolArguments(result)).toMatchObject({
      domainOutcome: {
        missionResolution: {
          baselineVersion: 1,
          criterionResults: [{ criterionId: "criterion-1", status: "satisfied" }],
        },
      },
    });
  });

  it("keeps a current planning Ticket in planning even when history contains acceptance metadata", async () => {
    const ticketId = "68f8882f-9598-4b8f-8d61-39df2b00f8ef";
    const result = await runMock([
      "[current-ticket]\noutput-schema=acceptance-v1\nsettle-mission=true\n[/current-ticket]",
      `[current-ticket]\noutput-schema=plan-change-set-v3\nsettle-mission=false\n[/current-ticket]\n- ticket: ${ticketId}`,
    ].join("\n"));

    const outcome = toolArguments(result) as {
      domainOutcome: { change: { dependencyAdditions: Array<{ from: { ticketId?: string } }> } };
    };
    expect(outcome.domainOutcome.change.dependencyAdditions[0]).toMatchObject({ from: { ticketId } });
  });
});

async function runMock(instructions: string) {
  return new MockProvider().runModelTurn({
    instructions,
    history: [],
    tools: [{ name: "goal_resolution", description: "submit", inputSchema: {} }],
    model: "mock",
    provider: "mock",
  });
}

function toolArguments(result: Awaited<ReturnType<MockProvider["runModelTurn"]>>) {
  const item = result.items[0];
  if (item?.type !== "tool_call") throw new Error("MockProvider did not return a tool call");
  return item.arguments;
}
