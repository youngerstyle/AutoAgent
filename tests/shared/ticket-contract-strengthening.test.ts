import { describe, expect, it } from "vitest";

import {
  type ClaimRequest,
  type TicketAggregateEventPayload,
  type TicketEventPage,
  type TicketId,
  type PlanId,
} from "../../src/shared/contracts/ticket-engine.js";

describe("strengthened Ticket Engine contracts", () => {
  it("requires plan and principal identity when claiming a ready Ticket", () => {
    const claim = {
      requestId: "claim-request-1",
      planId: "plan-1" as PlanId,
      ticketId: "ticket-1" as TicketId,
      expectedTicketVersion: 2,
      principalId: "principal-1",
      leaseDurationMs: 30_000,
    } satisfies ClaimRequest;

    expect(claim).toMatchObject({ planId: "plan-1", principalId: "principal-1" });

    if (false) {
      // @ts-expect-error A Ticket claim cannot be authorized without its plan partition.
      const missingPlan: ClaimRequest = { requestId: "claim-2", ticketId: "ticket-1" as TicketId, expectedTicketVersion: 2, principalId: "principal-1", leaseDurationMs: 30_000 };
      // @ts-expect-error A Ticket claim cannot be authorized without the claiming principal.
      const missingPrincipal: ClaimRequest = { requestId: "claim-3", planId: "plan-1" as PlanId, ticketId: "ticket-1" as TicketId, expectedTicketVersion: 2, leaseDurationMs: 30_000 };
      void [missingPlan, missingPrincipal];
    }
  });

  it("keeps aggregate identity in the event envelope instead of duplicating it in payloads", () => {
    const acceptPayload = (_payload: TicketAggregateEventPayload) => undefined;

    acceptPayload({ type: "TicketReady", ticketVersion: 3 });
    if (false) {
      // @ts-expect-error Duplicated Ticket IDs could disagree with envelope.aggregateId.
      acceptPayload({ type: "TicketReady", ticketId: "ticket-other" as TicketId, ticketVersion: 3 });
      // @ts-expect-error Plan identity belongs to the event envelope, not its payload.
      acceptPayload({ type: "PlanStatusChanged", planId: "plan-other" as PlanId, status: "active" });
    }
  });

  it("binds every event in a page to the page plan partition", () => {
    const planId = "plan-1" as PlanId<"plan-1">;
    const otherPlanId = "plan-2" as PlanId<"plan-2">;

    if (false) {
      const invalidPage: TicketEventPage<typeof planId> = {
        // @ts-expect-error Events from another plan cannot enter this page.
        events: [{ eventId: "event-1", planId: otherPlanId, aggregateType: "plan", aggregateId: otherPlanId, aggregateVersion: 1, occurredAt: "2026-07-10T04:00:00.000Z", payload: { type: "PlanStatusChanged", status: "active" } }],
        nextCursor: { source: "ticket", partitionId: planId, position: "1" },
      };
      void invalidPage;
    }

    expect(planId).not.toBe(otherPlanId);
  });
});
