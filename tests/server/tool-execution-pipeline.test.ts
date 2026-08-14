import { describe, expect, it, vi } from "vitest";
import { ToolExecutionPipeline } from "../../src/server/agent-engine/tool-execution-pipeline.js";

describe("ToolExecutionPipeline", () => {
  it("runs pre, nested execute middleware, terminal and post in deterministic order", async () => {
    const order: string[] = [];
    const pipeline = new ToolExecutionPipeline<{ name: string }, { actor: string }, { value: number }>(
      [() => { order.push("pre"); return undefined; }],
      [async (_request, next) => {
        order.push("around-before");
        const result = await next();
        order.push("around-after");
        return { value: result.value + 1 };
      }],
      [(_request, result) => {
        order.push("post");
        return { value: result.value + 1 };
      }],
    );

    await expect(pipeline.run({ intent: { name: "read" }, context: { actor: "dev" } }, async () => {
      order.push("terminal");
      return { value: 1 };
    })).resolves.toEqual({ value: 3 });
    expect(order).toEqual(["pre", "around-before", "terminal", "around-after", "post"]);
  });

  it("audits a pre-execute short circuit without entering execution", async () => {
    const terminal = vi.fn(async () => ({ ok: true }));
    const post = vi.fn((_request, result: { ok: boolean; reason?: string }) => result);
    const pipeline = new ToolExecutionPipeline<{ name: string }, never, { ok: boolean; reason?: string }>(
      [() => ({ ok: false, reason: "denied" })], [], [post],
    );

    await expect(pipeline.run({ intent: { name: "shell" } }, terminal)).resolves.toEqual({ ok: false, reason: "denied" });
    expect(terminal).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledOnce();
  });

  it("rejects execute middleware that delegates twice", async () => {
    const pipeline = new ToolExecutionPipeline<{}, never, string>([], [async (_request, next) => {
      await next();
      return next();
    }]);

    await expect(pipeline.run({ intent: {} }, async () => "ok")).rejects.toThrow("called next() more than once");
  });
});
