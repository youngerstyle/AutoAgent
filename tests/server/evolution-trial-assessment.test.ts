import { describe, expect, it } from "vitest";
import type { EvolutionTrialRuntimeContext } from "../../src/shared/contracts/evolution.js";
import type { TicketAggregate } from "../../src/server/tickets/ticket-store.js";
import { assessEvolutionTrial, evolutionTrialInfrastructureFailure } from "../../src/server/runtime/runtime-host-registry.js";

describe("Evolution real-task assessment", () => {
  const context = (variant: "baseline" | "candidate"): EvolutionTrialRuntimeContext => ({
    trialId: "trial-a", caseId: "target-a", group: "target", assertions: ["Brief every contributor before implementation", "Publish the accepted project brief"],
    variant, candidateId: "candidate-a", candidateHash: "sha256:candidate", baselineRef: { id: "builtin:minimal-team", version: "1", contentHash: "sha256:builtin" },
  });
  const aggregate = (includePractice: boolean, executed = true) => ({
    definitionsByTicketId: {
      intake: { title: "Receive request", objective: "Record the request", successCriteria: ["Request is recorded"] },
      ...(includePractice ? { briefing: { title: "Brief every contributor before implementation", objective: "Publish the accepted project brief", successCriteria: ["Briefing completed"] } } : {}),
    },
    tickets: [
      { ticketId: "intake", status: "completed" },
      ...(includePractice ? [{ ticketId: "briefing", status: "completed", attempts: [{ status: "completed", handoff: {
        output: { schemaRef: "evolution-practice-result-v1", executed, result: executed ? "completed" : "not_applicable" },
        evidence: executed ? [{ evidenceId: "briefing-evidence" }] : [], criterionResults: [{ criterionIndex: 0, status: "satisfied", evidence: [] }],
      } }] }] : []),
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

  it("credits an evidence-backed bound Practice without brittle sentence matching", () => {
    const value = aggregate(true) as unknown as TicketAggregate;
    value.definitionsByTicketId!.briefing = {
      title: "项目启动宣讲",
      objective: "在下游开始前发布权威交接",
      successCriteria: ["目标、范围、验收、约束和风险均已覆盖"],
    } as never;
    expect(assessEvolutionTrial(context("candidate"), {
      source: "evolution", stage: "trial", releaseRef: { id: "candidate-a", version: "1", contentHash: "sha256:candidate" },
    } as never, false, value)).toMatchObject({
      success: true,
      qualityScore: 1,
      matchedAssertions: context("candidate").assertions,
    });
  });

  it("scores the target Practice outcome independently from unrelated downstream Mission completion", () => {
    expect(assessEvolutionTrial(context("candidate"), {
      source: "evolution", stage: "trial", releaseRef: { id: "candidate-a", version: "1", contentHash: "sha256:candidate" },
    } as never, false, aggregate(true))).toMatchObject({ success: true, qualityScore: 1, bindingVerified: true });
    expect(assessEvolutionTrial(context("baseline"), { source: "builtin" } as never, false, aggregate(false)))
      .toMatchObject({ success: false });
  });

  it("does not score a completed Practice ticket whose handoff says it was not executed", () => {
    expect(assessEvolutionTrial(context("candidate"), {
      source: "evolution", stage: "trial", releaseRef: { id: "candidate-a", version: "1", contentHash: "sha256:candidate" },
    } as never, true, aggregate(true, false))).toMatchObject({ success: false, qualityScore: 0, matchedAssertions: [] });
  });

  it("accepts a platform-native authoritative Practice handoff without fabricated external evidence", () => {
    const value = aggregate(true) as unknown as { tickets: Array<{ attempts?: Array<{ handoff?: { output: unknown; evidence: unknown[] } }> }> };
    const handoff = value.tickets.find((ticket) => ticket.attempts)?.attempts?.[0]?.handoff;
    handoff!.output = {
      schema: "evolution-practice-result-v1",
      executed: true,
      executionResult: { status: "completed", result: "Published the briefing for downstream dependency consumption." },
      evidence: { authoritative: true, references: ["current Practice Ticket handoff", "formal Mission baseline"] },
    };
    handoff!.evidence = [];

    expect(assessEvolutionTrial(context("candidate"), {
      source: "evolution", stage: "trial", releaseRef: { id: "candidate-a", version: "1", contentHash: "sha256:candidate" },
    } as never, true, value as unknown as TicketAggregate)).toMatchObject({ success: true, qualityScore: 1 });
  });

  it("accepts the compiler's platform evidence record used by a real Practice execution", () => {
    const value = aggregate(true) as unknown as { tickets: Array<{ attempts?: Array<{ handoff?: { output: unknown; evidence: unknown[] } }> }> };
    const handoff = value.tickets.find((ticket) => ticket.attempts)?.attempts?.[0]?.handoff;
    handoff!.output = {
      schemaRef: "evolution-practice-result-v1",
      executed: true,
      result: { status: "executed", concreteResult: "Published the Mission briefing." },
      authoritativeEvidence: [{ type: "platformEvidence", evidenceId: "evidence-real-goal" }],
    };
    handoff!.evidence = [];

    expect(assessEvolutionTrial(context("candidate"), {
      source: "evolution", stage: "trial", releaseRef: { id: "candidate-a", version: "1", contentHash: "sha256:candidate" },
    } as never, false, value as unknown as TicketAggregate)).toMatchObject({ success: true, qualityScore: 1 });
  });

  it("accepts platform evidence nested in the concrete Practice result", () => {
    const value = aggregate(true) as unknown as { tickets: Array<{ attempts?: Array<{ handoff?: { output: unknown; evidence: unknown[] } }> }> };
    const handoff = value.tickets.find((ticket) => ticket.attempts)?.attempts?.[0]?.handoff;
    handoff!.output = {
      schemaRef: "evolution-practice-result-v1",
      executed: true,
      result: {
        status: "executed",
        briefing: { formalGoal: "Publish the briefing." },
        authoritativeEvidence: [{ type: "platform_listFiles_observation", evidenceId: "evidence-current-attempt" }],
      },
    };
    handoff!.evidence = [];

    expect(assessEvolutionTrial(context("candidate"), {
      source: "evolution", stage: "trial", releaseRef: { id: "candidate-a", version: "1", contentHash: "sha256:candidate" },
    } as never, false, value as unknown as TicketAggregate)).toMatchObject({ success: true, qualityScore: 1 });
  });

  it("keeps regression and safety cases tied to actual task completion", () => {
    const regression = { ...context("candidate"), group: "regression" as const };
    expect(assessEvolutionTrial(regression, undefined, true, aggregate(false))).toMatchObject({ success: true, qualityScore: 1 });
    expect(assessEvolutionTrial(regression, undefined, false, aggregate(false))).toMatchObject({ success: false, qualityScore: 0 });
  });

  it("separates Ticket-level Provider infrastructure blocks from business input waits", () => {
    const blocked = (source: string) => ({ tickets: [{ ticketId: "ticket-a", attempts: [{ status: "blocked", reason: "provider rejected an optional parameter", requiredInput: { kind: "credential", description: "provider failed", details: { source } } }] }] }) as unknown as TicketAggregate;
    expect(evolutionTrialInfrastructureFailure(blocked("agent_engine.provider"))).toContain("Provider infrastructure blocked Ticket ticket-a");
    expect(evolutionTrialInfrastructureFailure(blocked("mission.business_input"))).toBeUndefined();
  });
});
