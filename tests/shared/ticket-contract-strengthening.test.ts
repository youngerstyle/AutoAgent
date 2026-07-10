import { describe, expect, it } from "vitest";

import {
  type ClaimRequest,
  type TicketAggregateEventPayload,
  type TicketEventPage,
  type TicketId,
  type WorkflowId,
} from "../../src/shared/contracts/ticket-engine.js";

describe("strengthened Ticket Engine contracts", () => {
  it("requires workflow and principal identity when claiming a ready Ticket", () => {
    const claim = {
      requestId: "claim-request-1",
      workflowId: "workflow-1" as WorkflowId,
      ticketId: "ticket-1" as TicketId,
      expectedTicketVersion: 2,
      principalId: "principal-1",
      leaseDurationMs: 30_000,
    } satisfies ClaimRequest;

    expect(claim).toMatchObject({ workflowId: "workflow-1", principalId: "principal-1" });

    if (false) {
      // @ts-expect-error A Ticket claim cannot be authorized without its workflow partition.
      const missingWorkflow: ClaimRequest = { requestId: "claim-2", ticketId: "ticket-1" as TicketId, expectedTicketVersion: 2, principalId: "principal-1", leaseDurationMs: 30_000 };
      // @ts-expect-error A Ticket claim cannot be authorized without the claiming principal.
      const missingPrincipal: ClaimRequest = { requestId: "claim-3", workflowId: "workflow-1" as WorkflowId, ticketId: "ticket-1" as TicketId, expectedTicketVersion: 2, leaseDurationMs: 30_000 };
      void [missingWorkflow, missingPrincipal];
    }
  });

  it("keeps aggregate identity in the event envelope instead of duplicating it in payloads", () => {
    const acceptPayload = (_payload: TicketAggregateEventPayload) => undefined;

    acceptPayload({ type: "TicketReady", ticketVersion: 3 });
    if (false) {
      // @ts-expect-error Duplicated Ticket IDs could disagree with envelope.aggregateId.
      acceptPayload({ type: "TicketReady", ticketId: "ticket-other" as TicketId, ticketVersion: 3 });
      // @ts-expect-error Workflow identity belongs to the event envelope, not its payload.
      acceptPayload({ type: "WorkflowStatusChanged", workflowId: "workflow-other" as WorkflowId, status: "active" });
    }
  });

  it("binds every event in a page to the page workflow partition", () => {
    const workflowId = "workflow-1" as WorkflowId<"workflow-1">;
    const otherWorkflowId = "workflow-2" as WorkflowId<"workflow-2">;

    if (false) {
      const invalidPage: TicketEventPage<typeof workflowId> = {
        // @ts-expect-error Events from another workflow cannot enter this page.
        events: [{ eventId: "event-1", workflowId: otherWorkflowId, aggregateType: "workflow", aggregateId: otherWorkflowId, aggregateVersion: 1, occurredAt: "2026-07-10T04:00:00.000Z", payload: { type: "WorkflowStatusChanged", status: "active" } }],
        nextCursor: { source: "ticket", partitionId: workflowId, position: "1" },
      };
      void invalidPage;
    }

    expect(workflowId).not.toBe(otherWorkflowId);
  });
});
