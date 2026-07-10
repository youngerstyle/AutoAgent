import { describe, expect, it } from "vitest";
import type {
  PlannedTicketGraph,
  PlannedWorkflowCompletionPolicy,
  TicketId,
  TicketNodeKey,
  TicketStatus,
  WorkflowId,
} from "../../src/shared/contracts/ticket-engine.js";
import {
  computeRequiredClosure,
  evaluateWorkflowOutcome,
  findUnresolvedRequiredFailures,
  materializeWorkflowGraph,
} from "../../src/server/tickets/workflow-graph.js";

const workflowId = "wf_graph_rules" as WorkflowId;
const key = (value: string) => value as TicketNodeKey;

function node(value: string, overrides: Record<string, unknown> = {}) {
  return {
    key: key(value),
    title: value,
    objective: `完成 ${value}`,
    successCriteria: [`${value} 完成`],
    assignment: {},
    outputContract: { schemaRef: `schema://${value}` },
    ...overrides,
  };
}

function graph(
  nodes: PlannedTicketGraph["nodes"],
  edges: Array<[string, string]> = [],
): PlannedTicketGraph {
  return {
    schemaVersion: 2,
    nodes,
    dependencyEdges: edges.map(([fromKey, toKey]) => ({
      fromKey: key(fromKey),
      toKey: key(toKey),
    })),
  };
}

function policy(...requiredTerminalKeys: string[]): PlannedWorkflowCompletionPolicy {
  return {
    requiredTerminalKeys: requiredTerminalKeys.map(key),
    failurePolicy: "require_resolution",
    blockedPolicy: "wait",
  };
}

function statuses(entries: Array<[TicketId, TicketStatus]>): ReadonlyMap<TicketId, TicketStatus> {
  return new Map(entries);
}

describe("workflow graph materialization", () => {
  it("rejects duplicate keys, missing references, and cycles", () => {
    expect(() =>
      materializeWorkflowGraph({
        workflowId,
        graph: graph([node("same"), node("same")]),
        completionPolicy: policy("same"),
      }),
    ).toThrow(/duplicate.*same/i);

    expect(() =>
      materializeWorkflowGraph({
        workflowId,
        graph: graph([node("only", { parentKey: key("missing") })]),
        completionPolicy: policy("only"),
      }),
    ).toThrow(/missing.*parent/i);

    expect(() =>
      materializeWorkflowGraph({
        workflowId,
        graph: graph([node("a"), node("b")], [["a", "missing"]]),
        completionPolicy: policy("b"),
      }),
    ).toThrow(/missing.*dependency/i);

    expect(() =>
      materializeWorkflowGraph({
        workflowId,
        graph: graph([node("a"), node("b")], [["a", "b"], ["b", "a"]]),
        completionPolicy: policy("b"),
      }),
    ).toThrow(/cycle/i);
  });

  it("materializes deterministic runtime IDs and resolves terminal keys", () => {
    const planned = graph([node("plan"), node("build"), node("qa")], [
      ["plan", "build"],
      ["build", "qa"],
    ]);
    const first = materializeWorkflowGraph({
      workflowId,
      graph: planned,
      completionPolicy: policy("qa"),
    });
    const reordered = materializeWorkflowGraph({
      workflowId,
      graph: graph([node("qa"), node("build"), node("plan")], [
        ["build", "qa"],
        ["plan", "build"],
      ]),
      completionPolicy: policy("qa"),
    });

    expect(first.ticketIdByKey).toEqual(reordered.ticketIdByKey);
    expect(first.graph).toEqual(reordered.graph);
    expect(first.plannedGraph).toEqual(reordered.plannedGraph);
    expect(first.graph.nodes.map((item) => item.ticketId)).not.toContain(key("qa"));
    expect(first.completionPolicy.requiredTerminalTicketIds).toEqual([
      first.ticketIdByKey.qa,
    ]);
    expect(first.graph.dependencyEdges).toEqual([
      {
        fromTicketId: first.ticketIdByKey.plan,
        toTicketId: first.ticketIdByKey.build,
      },
      {
        fromTicketId: first.ticketIdByKey.build,
        toTicketId: first.ticketIdByKey.qa,
      },
    ]);

    const parallel = graph([node("left"), node("right")]);
    const leftRight = materializeWorkflowGraph({
      workflowId,
      graph: parallel,
      completionPolicy: policy("left", "right"),
    });
    const rightLeft = materializeWorkflowGraph({
      workflowId,
      graph: graph([node("right"), node("left")]),
      completionPolicy: policy("right", "left"),
    });
    expect(leftRight.completionPolicy).toEqual(rightLeft.completionPolicy);
  });

  it("does not mutate caller-owned graph or completion policy", () => {
    const inputGraph = graph([node("plan"), node("qa")], [["plan", "qa"]]);
    const inputPolicy = policy("qa");
    const before = JSON.stringify({ inputGraph, inputPolicy });

    materializeWorkflowGraph({
      workflowId,
      graph: inputGraph,
      completionPolicy: inputPolicy,
    });

    expect(JSON.stringify({ inputGraph, inputPolicy })).toBe(before);
  });

  it("preserves immutable keys and requires explicit cancellation for omitted active nodes", () => {
    const initial = materializeWorkflowGraph({
      workflowId,
      graph: graph([node("plan"), node("build"), node("qa")], [
        ["plan", "build"],
        ["build", "qa"],
      ]),
      completionPolicy: policy("qa"),
    });

    expect(() =>
      materializeWorkflowGraph({
        workflowId,
        graph: graph([
          node("plan"),
          node("build", { objective: "偷偷改变旧 key" }),
          node("qa"),
        ]),
        completionPolicy: policy("qa"),
        previous: initial,
      }),
    ).toThrow(/immutable.*build/i);

    expect(() =>
      materializeWorkflowGraph({
        workflowId,
        graph: graph([node("plan"), node("qa")], [["plan", "qa"]]),
        completionPolicy: policy("qa"),
        previous: initial,
      }),
    ).toThrow(/cancelTicketIds.*build/i);

    const amended = materializeWorkflowGraph({
      workflowId,
      graph: graph([node("plan"), node("qa")], [["plan", "qa"]]),
      completionPolicy: policy("qa"),
      previous: initial,
      cancelTicketIds: [initial.ticketIdByKey.build],
    });

    expect(amended.graph.nodes.find((item) => item.nodeKey === key("build"))).toMatchObject({
      active: false,
      ticketId: initial.ticketIdByKey.build,
    });

    expect(() =>
      materializeWorkflowGraph({
        workflowId,
        graph: graph([node("plan"), node("build"), node("qa")], [
          ["plan", "build"],
          ["build", "qa"],
        ]),
        completionPolicy: policy("qa"),
        previous: initial,
        cancelTicketIds: [initial.ticketIdByKey.build],
      }),
    ).toThrow(/cancel.*retained.*build/i);

    expect(() =>
      materializeWorkflowGraph({
        workflowId,
        graph: graph([node("plan"), node("build"), node("qa")], [
          ["plan", "build"],
          ["build", "qa"],
        ]),
        completionPolicy: policy("qa"),
        previous: amended,
      }),
    ).toThrow(/inactive.*build.*reused/i);
  });

  it("creates one active successor and records both sides of a revision", () => {
    const initial = materializeWorkflowGraph({
      workflowId,
      graph: graph([node("build-v1"), node("qa-v1")], [["build-v1", "qa-v1"]]),
      completionPolicy: policy("qa-v1"),
    });
    const revised = materializeWorkflowGraph({
      workflowId,
      graph: graph(
        [
          node("build-v2", { revisionOfKey: key("build-v1") }),
          node("qa-v2", { revisionOfKey: key("qa-v1") }),
        ],
        [["build-v2", "qa-v2"]],
      ),
      completionPolicy: policy("qa-v2"),
      previous: initial,
    });

    expect(revised.graph.nodes.find((item) => item.nodeKey === key("build-v1"))).toMatchObject({
      active: false,
      supersededByTicketId: revised.ticketIdByKey["build-v2"],
    });
    expect(revised.graph.nodes.find((item) => item.nodeKey === key("build-v2"))).toMatchObject({
      active: true,
      revisionOfTicketId: initial.ticketIdByKey["build-v1"],
    });

    expect(() =>
      materializeWorkflowGraph({
        workflowId,
        graph: graph([
          node("build-v2", { revisionOfKey: key("build-v1") }),
          node("build-v3", { revisionOfKey: key("build-v1") }),
        ]),
        completionPolicy: policy("build-v3"),
        previous: initial,
      }),
    ).toThrow(/active successor/i);
  });
});

describe("workflow completion rules", () => {
  it("computes the reverse required closure from runtime terminal IDs", () => {
    const materialized = materializeWorkflowGraph({
      workflowId,
      graph: graph([node("optional"), node("plan"), node("build"), node("qa")], [
        ["plan", "build"],
        ["build", "qa"],
      ]),
      completionPolicy: policy("qa"),
    });

    expect([...computeRequiredClosure(materialized.graph, materialized.completionPolicy)]).toEqual([
      materialized.ticketIdByKey.qa,
      materialized.ticketIdByKey.build,
      materialized.ticketIdByKey.plan,
    ]);
  });

  it("only resolves a required failure through a revision chain entering the new closure", () => {
    const initial = materializeWorkflowGraph({
      workflowId,
      graph: graph([node("build-v1"), node("qa-v1")], [["build-v1", "qa-v1"]]),
      completionPolicy: policy("qa-v1"),
    });
    const failed = statuses([
      [initial.ticketIdByKey["build-v1"], "failed"],
      [initial.ticketIdByKey["qa-v1"], "pending"],
    ]);

    const deletedOnly = materializeWorkflowGraph({
      workflowId,
      graph: graph([node("replacement")]),
      completionPolicy: policy("replacement"),
      previous: initial,
      cancelTicketIds: [initial.ticketIdByKey["build-v1"], initial.ticketIdByKey["qa-v1"]],
    });
    expect(
      findUnresolvedRequiredFailures({
        previous: initial,
        next: deletedOnly,
        ticketStatuses: failed,
      }),
    ).toEqual([initial.ticketIdByKey["build-v1"]]);

    const revised = materializeWorkflowGraph({
      workflowId,
      graph: graph(
        [
          node("build-v2", { revisionOfKey: key("build-v1") }),
          node("qa-v2", { revisionOfKey: key("qa-v1") }),
        ],
        [["build-v2", "qa-v2"]],
      ),
      completionPolicy: policy("qa-v2"),
      previous: initial,
    });
    expect(
      findUnresolvedRequiredFailures({
        previous: initial,
        next: revised,
        ticketStatuses: failed,
      }),
    ).toEqual([]);
  });

  it("completes only when terminals are complete and no active work remains", () => {
    const materialized = materializeWorkflowGraph({
      workflowId,
      graph: graph([node("build"), node("qa")], [["build", "qa"]]),
      completionPolicy: policy("qa"),
    });

    expect(
      evaluateWorkflowOutcome({
        materialized,
        ticketStatuses: statuses([
          [materialized.ticketIdByKey.build, "completed"],
          [materialized.ticketIdByKey.qa, "completed"],
        ]),
      }),
    ).toBe("completed");

    expect(
      evaluateWorkflowOutcome({
        materialized,
        ticketStatuses: statuses([
          [materialized.ticketIdByKey.build, "completed"],
          [materialized.ticketIdByKey.qa, "ready"],
        ]),
      }),
    ).toBe("active");
  });
});
