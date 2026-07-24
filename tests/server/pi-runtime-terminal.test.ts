import { describe, expect, it } from "vitest";
import {
  awaitPiPromptOutcome,
  compactPiToolEventDetails,
} from "../../src/server/agent-engine/pi-runtime.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("Pi runtime terminal propagation", () => {
  it("returns when the Pi prompt settles normally", async () => {
    const terminal = deferred<string>();

    await expect(awaitPiPromptOutcome(Promise.resolve(), terminal.promise))
      .resolves.toEqual({ kind: "settled" });
  });

  it("does not finish a queued Pi prompt until the Agent session is idle", async () => {
    const terminal = deferred<string>();
    const idle = deferred<void>();
    let settled = false;
    const outcome = awaitPiPromptOutcome(
      Promise.resolve(),
      terminal.promise,
      () => idle.promise,
    ).then((value) => {
      settled = true;
      return value;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    idle.resolve();
    await expect(outcome).resolves.toEqual({ kind: "settled" });
  });

  it("surfaces a final provider error even when the Pi prompt never settles", async () => {
    const prompt = deferred<void>();
    const terminal = deferred<string>();
    const outcome = awaitPiPromptOutcome(prompt.promise, terminal.promise);

    terminal.resolve("502 status code (no body)");

    await expect(outcome).resolves.toEqual({
      kind: "provider_error",
      message: "502 status code (no body)",
    });
  });

  it("keeps tool event metadata without duplicating large text payloads", () => {
    const details = compactPiToolEventDetails({
      content: [{ type: "text", text: "x".repeat(100_000) }],
      details: {
        content: "x".repeat(100_000),
        path: "logs/tank98.log",
        totalChars: 1_000_000,
        truncated: true,
        nextOffset: 32_000,
      },
      isError: false,
    });

    expect(details).toEqual({
      isError: false,
      details: {
        path: "logs/tank98.log",
        totalChars: 1_000_000,
        truncated: true,
        nextOffset: 32_000,
      },
    });
    expect(JSON.stringify(details)).not.toContain("xxxxx");
  });
});
