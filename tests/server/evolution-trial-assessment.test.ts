import { describe, expect, it } from "vitest";
import type { EvolutionTrialRuntimeContext } from "../../src/shared/contracts/evolution.js";
import type { TicketAggregate } from "../../src/server/tickets/ticket-store.js";
import { assessEvolutionTrial } from "../../src/server/runtime/runtime-host-registry.js";

describe("Evolution real-task assessment", () => {
  const context = (variant: "baseline" | "candidate"): EvolutionTrialRuntimeContext => ({
    trialId: "trial-a", caseId: "target-a", group: "target", assertions: ["Brief every contributor before implementation", "Publish the accepted project brief"],
    variant, candidateId: "candidate-a", candidateHash: "sha256:candidate", baselineRef: { id: "builtin:minimal-team", version: "1", contentHash: "sha256:builtin" },
  });
  const aggregate = (includePractice: boolean) => ({
    definitionsByTicketId: {
      intake: { title: "Receive request", objective: "Record the request", successCriteria: ["Request is recorded"] },
      ...(includePractice ? { briefing: { title: "Brief every contributor before implementation", objective: "Publish the accepted project brief", successCriteria: ["Briefing completed"] } } : {}),
    },
    tickets: [
      { ticketId: "intake", status: "completed" },
      ...(includePractice ? [{ ticketId: "briefing", status: "completed" }] : []),
    ],
  }) as unknown as TicketAggregate;

  it("distinguishes a completed baseline from a candidate that loaded and executed the learned Workflow step", () => {
    expect(assessEvolutionTrial(context("baseline"), { source: "builtin" } as never, true, aggregate(false)))
      .toMatchObject({ success: false, qualityScore: 0, bindingVerified: true, matchedAssertions: [] });
    expect(assessEvolutionTrial(context("candidate"), {
      source: "evolution", stage: "trial", releaseRef: { id: "candidate-a", version: "1", contentHash: "sha256:candidate" },
    } as never, true, aggregate(true))).toMatchObject({
      success: true, qualityScore: 1, bindingVerified: true,
      matchedAssertions: context("candidate").assertions,
    });
  });

  it("rejects assertion-shaped tickets when the frozen candidate binding was not loaded", () => {
    expect(assessEvolutionTrial(context("candidate"), { source: "builtin" } as never, true, aggregate(true)))
      .toMatchObject({ success: false, qualityScore: 1, bindingVerified: false });
  });

  it("keeps regression and safety cases tied to actual task completion", () => {
    const regression = { ...context("candidate"), group: "regression" as const };
    expect(assessEvolutionTrial(regression, undefined, true, aggregate(false))).toMatchObject({ success: true, qualityScore: 1 });
    expect(assessEvolutionTrial(regression, undefined, false, aggregate(false))).toMatchObject({ success: false, qualityScore: 0 });
  });
});
