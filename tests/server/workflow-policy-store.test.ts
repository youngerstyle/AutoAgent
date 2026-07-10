import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  WorkflowPolicyConflictError,
  WorkflowPolicyIntegrityError,
  WorkflowPolicyNotFoundError,
  WorkflowPolicyStore,
  createWorkflowPolicy,
} from "../../src/server/tickets/workflow-policy-store.js";

describe("WorkflowPolicyStore", () => {
  it("seeds and reads an immutable policy by its content-addressed ref", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-workflow-policy-"));
    const store = new WorkflowPolicyStore(root);
    const policy = createWorkflowPolicy({
      policyId: "minimal-team",
      policyVersion: 1,
      grants: [{ principalId: "planner-1", capabilities: ["ticket_graph:create"] }],
    });

    await store.seedPolicy(policy);

    await expect(store.getPolicy(policy.ref)).resolves.toEqual(policy);
    const persisted = JSON.parse(await readFile(
      path.join(root, "workflow-policies", "minimal-team", "1.json"),
      "utf8",
    ));
    expect(persisted).toEqual(policy);
  });

  it("verifies the declared contentHash before writing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-workflow-policy-"));
    const store = new WorkflowPolicyStore(root);
    const policy = createWorkflowPolicy({
      policyId: "minimal-team",
      policyVersion: 1,
      grants: [{ principalId: "planner-1", capabilities: ["ticket_graph:create"] }],
    });

    await expect(store.seedPolicy({
      ...policy,
      ref: { ...policy.ref, contentHash: "sha256:tampered" },
    })).rejects.toBeInstanceOf(WorkflowPolicyIntegrityError);
  });

  it("rejects a different policy body for an existing id and version", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-workflow-policy-"));
    const store = new WorkflowPolicyStore(root);
    const original = createWorkflowPolicy({
      policyId: "minimal-team",
      policyVersion: 1,
      grants: [{ principalId: "planner-1", capabilities: ["ticket_graph:create"] }],
    });
    const changed = createWorkflowPolicy({
      policyId: "minimal-team",
      policyVersion: 1,
      grants: [{ principalId: "planner-1", capabilities: ["workflow:control"] }],
    });
    await store.seedPolicy(original);

    await expect(store.seedPolicy(changed)).rejects.toBeInstanceOf(WorkflowPolicyConflictError);
    await expect(store.getPolicy(original.ref)).resolves.toEqual(original);
  });

  it("rejects the same ref when its content differs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-workflow-policy-"));
    const store = new WorkflowPolicyStore(root);
    const original = createWorkflowPolicy({
      policyId: "minimal-team",
      policyVersion: 1,
      grants: [{ teamBindingId: "team-1", capabilities: ["ticket:claim"] }],
    });
    await store.seedPolicy(original);

    await expect(store.seedPolicy({
      ref: original.ref,
      grants: [{ teamBindingId: "team-2", capabilities: ["ticket:claim"] }],
    })).rejects.toBeInstanceOf(WorkflowPolicyIntegrityError);
  });

  it("rejects a required policy that is missing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-workflow-policy-"));
    const store = new WorkflowPolicyStore(root);

    await expect(store.requirePolicy({
      policyId: "missing",
      policyVersion: 1,
      contentHash: `sha256:${"0".repeat(64)}`,
    })).rejects.toBeInstanceOf(WorkflowPolicyNotFoundError);
  });

  it("grants capabilities only through matching principals or team bindings", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-workflow-policy-"));
    const store = new WorkflowPolicyStore(root);
    const policy = createWorkflowPolicy({
      policyId: "minimal-team",
      policyVersion: 1,
      grants: [
        { principalId: "planner-1", capabilities: ["ticket_graph:create"] },
        { teamBindingId: "team-1", capabilities: ["ticket:claim"] },
      ],
    });
    await store.seedPolicy(policy);

    await expect(store.hasCapability(policy.ref, {
      principalId: "planner-1",
      teamBindingIds: [],
    }, "ticket_graph:create")).resolves.toBe(true);
    await expect(store.hasCapability(policy.ref, {
      principalId: "worker-1",
      teamBindingIds: ["team-1"],
    }, "ticket:claim")).resolves.toBe(true);
    await expect(store.hasCapability(policy.ref, {
      principalId: "worker-1",
      teamBindingIds: ["team-2"],
    }, "ticket:claim")).resolves.toBe(false);
  });

  it("restores seeded policies after constructing a new store", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-workflow-policy-"));
    const policy = createWorkflowPolicy({
      policyId: "minimal-team",
      policyVersion: 2,
      grants: [{ teamBindingId: "team-1", capabilities: ["ticket:claim"] }],
    });
    await new WorkflowPolicyStore(root).seedPolicy(policy);

    const restarted = new WorkflowPolicyStore(root);
    await expect(restarted.requirePolicy(policy.ref)).resolves.toEqual(policy);
  });
});
