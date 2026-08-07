import { describe, expect, it } from "vitest";
import { RuntimeExecutionGate, RuntimeHostScheduler } from "../../src/server/runtime/runtime-scheduler.js";

const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error("Timed out waiting for runtime scheduler state");
    await wait(5);
  }
}

describe("runtime scheduler", () => {
  it("coalesces workspace wakeups and bounds concurrent host work", async () => {
    const scheduler = new RuntimeHostScheduler(2, 60_000);
    let active = 0;
    let maximumActive = 0;
    let calls = 0;
    let accepting = true;
    const releases: Array<() => void> = [];
    const work = async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      calls += 1;
      if (accepting) await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
    };

    try {
      scheduler.register("workspace-a", work);
      scheduler.register("workspace-b", work);
      scheduler.register("workspace-c", work);
      scheduler.request("workspace-a");
      scheduler.request("workspace-a");
      scheduler.request("workspace-b");
      scheduler.request("workspace-c");

      await waitFor(() => active === 2);
      expect(calls).toBe(2);
      expect(maximumActive).toBe(2);

      accepting = false;
      for (const release of releases.splice(0)) release();
      await waitFor(() => active === 0 && calls === 4);
    } finally {
      for (const release of releases.splice(0)) release();
      await scheduler.stop();
    }
  });

  it("bounds model and tool turns across workspaces", async () => {
    const gate = new RuntimeExecutionGate(2);
    let active = 0;
    let maximumActive = 0;
    const runs = Array.from({ length: 6 }, async () => gate.run(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await wait(10);
      active -= 1;
      return true;
    }));

    await expect(Promise.all(runs)).resolves.toEqual([true, true, true, true, true, true]);
    expect(maximumActive).toBe(2);
    expect(active).toBe(0);
  });
});
