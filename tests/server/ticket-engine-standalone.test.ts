import { describe, expect, it } from "vitest";
import { TicketEngine } from "../../src/server/tickets/ticket-engine.js";

describe("standalone Ticket Engine boundary", () => {
  it("does not import Agent or Provider runtime code", async () => {
    expect(TicketEngine).toBeTypeOf("function");
    const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../../src/server/tickets/ticket-engine.ts", import.meta.url), "utf8"));
    expect(source).not.toMatch(/agent-engine|provider-adapter|prompt/i);
  });
});
