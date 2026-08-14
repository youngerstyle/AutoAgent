import { describe, expect, it } from "vitest";
import { isAgentInboxMessageConsumed, nextAgentInboxInput, projectAgentInbox } from "../../src/server/agent-engine/agent-inbox.js";

describe("Agent inbox projection", () => {
  it("keeps context non-waking and selects the earliest human turn", () => {
    const { thread, payloads } = fixture([
      ["context-a", "message", { content: "background", senderPrincipalId: "human", deliveryKind: "context", goalId: "goal-a" }],
      ["turn-a", "message", { content: "continue", senderPrincipalId: "human", deliveryKind: "turn", goalId: "goal-a" }],
    ]);
    const inbox = projectAgentInbox(thread as never, payloads);

    expect(inbox.map((entry) => entry.status)).toEqual(["context", "pending"]);
    expect(nextAgentInboxInput(inbox, { humanOnly: true, earliest: true, goalId: "goal-a" }))
      .toMatchObject({ itemId: "turn-a", content: "continue" });
  });

  it("treats retry wait as resumable rather than consumed", () => {
    const { thread, payloads } = fixture([
      ["turn-a", "message", { content: "continue", senderPrincipalId: "human", deliveryKind: "turn", goalId: "goal-a" }, "turn-1"],
      ["retry-a", "control", { status: "provider_retry_wait", triggerMessageId: "turn-a", goalId: "goal-a" }, "turn-1"],
    ]);
    const inbox = projectAgentInbox(thread as never, payloads);

    expect(inbox[0]).toMatchObject({ status: "retry_wait" });
    expect(isAgentInboxMessageConsumed(inbox, "turn-a")).toBe(false);
    expect(nextAgentInboxInput(inbox, { humanOnly: true })).toBeUndefined();
  });

  it("marks a human turn claimed from its durable running control", () => {
    const { thread, payloads } = fixture([
      ["turn-a", "message", { content: "ORBIT", senderPrincipalId: "human", deliveryKind: "turn", goalId: "goal-a" }, "turn-1"],
      ["running-a", "control", { status: "running", triggerMessageId: "turn-a", goalId: "goal-a" }, "turn-1"],
    ]);
    const inbox = projectAgentInbox(thread as never, payloads);

    expect(inbox[0]).toMatchObject({ status: "claimed" });
    expect(isAgentInboxMessageConsumed(inbox, "turn-a")).toBe(true);
  });
});

function fixture(rows: Array<[string, "message" | "control", Record<string, unknown>, string?]>) {
  const payloads = new Map<string, unknown>();
  const items = rows.map(([itemId, kind, value, turnId], index) => {
    const payloadRef = `payload-${index}`;
    payloads.set(payloadRef, value);
    return { itemId, kind, payloadRef, sequence: index + 1, ...(turnId ? { turnId } : {}) };
  });
  return { thread: { threadId: "thread-a", items }, payloads };
}
