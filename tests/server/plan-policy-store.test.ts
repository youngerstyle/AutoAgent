import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PlanPolicyConflictError,
  PlanPolicyIntegrityError,
  PlanPolicyNotFoundError,
  PlanPolicyStore,
  createPlanPolicy,
  fsyncPolicyDirectory,
} from "../../src/server/tickets/plan-policy-store.js";

describe("PlanPolicyStore", () => {
  it("seeds and reads an immutable policy by its content-addressed ref", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-plan-policy-"));
    const store = new PlanPolicyStore(root);
    const policy = createPlanPolicy({
      policyId: "minimal-team",
      policyVersion: 1,
      grants: [{ principalId: "planner-1", capabilities: ["plan:create"] }],
    });

    await store.seedPolicy(policy);

    await expect(store.getPolicy(policy.ref)).resolves.toEqual(policy);
    const persisted = JSON.parse(await readFile(
      path.join(root, "plan-policies", "minimal-team", "1.json"),
      "utf8",
    ));
    expect(persisted).toEqual(policy);
  });

  it("verifies the declared contentHash before writing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-plan-policy-"));
    const store = new PlanPolicyStore(root);
    const policy = createPlanPolicy({
      policyId: "minimal-team",
      policyVersion: 1,
      grants: [{ principalId: "planner-1", capabilities: ["plan:create"] }],
    });

    await expect(store.seedPolicy({
      ...policy,
      ref: { ...policy.ref, contentHash: "sha256:tampered" },
    })).rejects.toBeInstanceOf(PlanPolicyIntegrityError);
  });

  it.each([".", "..", ".hidden", "trailing."])("rejects unsafe policy id %s", async (policyId) => {
    expect(() => createPlanPolicy({
      policyId,
      policyVersion: 1,
      grants: [{ principalId: "planner-1", capabilities: ["plan:create"] }],
    })).toThrow(PlanPolicyIntegrityError);
  });

  it("rejects a different policy body for an existing id and version", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-plan-policy-"));
    const store = new PlanPolicyStore(root);
    const original = createPlanPolicy({
      policyId: "minimal-team",
      policyVersion: 1,
      grants: [{ principalId: "planner-1", capabilities: ["plan:create"] }],
    });
    const changed = createPlanPolicy({
      policyId: "minimal-team",
      policyVersion: 1,
      grants: [{ principalId: "planner-1", capabilities: ["plan:control"] }],
    });
    await store.seedPolicy(original);

    await expect(store.seedPolicy(changed)).rejects.toBeInstanceOf(PlanPolicyConflictError);
    await expect(store.getPolicy(original.ref)).resolves.toEqual(original);
  });

  it("rejects the same ref when its content differs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-plan-policy-"));
    const store = new PlanPolicyStore(root);
    const original = createPlanPolicy({
      policyId: "minimal-team",
      policyVersion: 1,
      grants: [{ teamBindingId: "team-1", capabilities: ["ticket:claim"] }],
    });
    await store.seedPolicy(original);

    await expect(store.seedPolicy({
      ref: original.ref,
      grants: [{ teamBindingId: "team-2", capabilities: ["ticket:claim"] }],
    })).rejects.toBeInstanceOf(PlanPolicyIntegrityError);
  });

  it("atomically creates one immutable version across competing processes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-plan-policy-race-"));
    const startFile = path.join(root, "start");
    const first = createPlanPolicy({
      policyId: "minimal-team",
      policyVersion: 1,
      grants: [{ principalId: "planner-1", capabilities: ["plan:create"] }],
    });
    const second = createPlanPolicy({
      policyId: "minimal-team",
      policyVersion: 1,
      grants: [{ principalId: "planner-1", capabilities: ["plan:control"] }],
    });

    const contenders = Array.from({ length: 24 }, (_, index) => (
      runSeedChild(root, startFile, index % 2 === 0 ? first : second)
    ));
    await Promise.all(contenders.map((contender) => contender.ready));
    await writeFile(startFile, "go", "utf8");
    const results = await Promise.all(contenders.map((contender) => contender.result));

    expect(results.every((result) => result.status !== "error")).toBe(true);
    expect(new Set(
      results.filter((result) => result.status === "seeded").map((result) => result.contentHash),
    ).size).toBe(1);
    expect(results.some((result) => result.status === "conflict")).toBe(true);
    const stored = JSON.parse(await readFile(
      path.join(root, "plan-policies", "minimal-team", "1.json"),
      "utf8",
    ));
    expect([first.ref.contentHash, second.ref.contentHash]).toContain(stored.ref.contentHash);
  });

  it("rejects policy content tampered on disk", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-plan-policy-"));
    const store = new PlanPolicyStore(root);
    const policy = createPlanPolicy({
      policyId: "minimal-team",
      policyVersion: 1,
      grants: [{ principalId: "planner-1", capabilities: ["plan:create"] }],
    });
    await store.seedPolicy(policy);
    await writeFile(
      path.join(root, "plan-policies", "minimal-team", "1.json"),
      JSON.stringify({ ...policy, grants: [{ principalId: "attacker", capabilities: ["plan:control"] }] }),
      "utf8",
    );

    await expect(store.getPolicy(policy.ref)).rejects.toBeInstanceOf(PlanPolicyIntegrityError);
  });

  it("drops unknown ref fields before hashing and persistence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-plan-policy-"));
    const store = new PlanPolicyStore(root);
    const policy = createPlanPolicy({
      policyId: "minimal-team",
      policyVersion: 1,
      grants: [{ principalId: "planner-1", capabilities: ["plan:create"] }],
    });
    const input = {
      ...policy,
      ref: { ...policy.ref, injectedAuthority: "plan:control" },
    } as typeof policy;

    await store.seedPolicy(input);

    const stored = JSON.parse(await readFile(
      path.join(root, "plan-policies", "minimal-team", "1.json"),
      "utf8",
    ));
    expect(stored.ref).toEqual(policy.ref);
  });

  it("merges duplicate subject grants so equivalent policies share one hash", () => {
    const split = createPlanPolicy({
      policyId: "minimal-team",
      policyVersion: 1,
      grants: [
        { principalId: "planner-1", capabilities: ["plan:control"] },
        { teamBindingId: "team-1", capabilities: ["ticket:claim"] },
        { principalId: "planner-1", capabilities: ["plan:create"] },
      ],
    });
    const merged = createPlanPolicy({
      policyId: "minimal-team",
      policyVersion: 1,
      grants: [
        { principalId: "planner-1", capabilities: ["plan:create", "plan:control"] },
        { teamBindingId: "team-1", capabilities: ["ticket:claim"] },
      ],
    });

    expect(split).toEqual(merged);
    expect(split.ref.contentHash).toBe(merged.ref.contentHash);
  });

  it("rejects a required policy that is missing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-plan-policy-"));
    const store = new PlanPolicyStore(root);

    await expect(store.requirePolicy({
      policyId: "missing",
      policyVersion: 1,
      contentHash: `sha256:${"0".repeat(64)}`,
    })).rejects.toBeInstanceOf(PlanPolicyNotFoundError);
  });

  it("grants capabilities only through matching principals or team bindings", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-plan-policy-"));
    const store = new PlanPolicyStore(root);
    const policy = createPlanPolicy({
      policyId: "minimal-team",
      policyVersion: 1,
      grants: [
        { principalId: "planner-1", capabilities: ["plan:create"] },
        { teamBindingId: "team-1", capabilities: ["ticket:claim"] },
      ],
    });
    await store.seedPolicy(policy);

    await expect(store.hasCapability(policy.ref, {
      principalId: "planner-1",
      teamBindingIds: [],
    }, "plan:create")).resolves.toBe(true);
    await expect(store.hasCapability(policy.ref, {
      principalId: "worker-1",
      teamBindingIds: ["team-1"],
    }, "ticket:claim")).resolves.toBe(true);
    await expect(store.hasCapability(policy.ref, {
      principalId: "worker-1",
      teamBindingIds: ["team-2"],
    }, "ticket:claim")).resolves.toBe(false);
    await expect(store.capabilitiesFor(policy.ref, {
      principalId: "planner-1",
      teamBindingIds: ["team-1"],
    })).resolves.toEqual(["plan:create", "ticket:claim"]);
  });

  it("restores seeded policies after constructing a new store", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-plan-policy-"));
    const policy = createPlanPolicy({
      policyId: "minimal-team",
      policyVersion: 2,
      grants: [{ teamBindingId: "team-1", capabilities: ["ticket:claim"] }],
    });
    await new PlanPolicyStore(root).seedPolicy(policy);

    const restarted = new PlanPolicyStore(root);
    await expect(restarted.requirePolicy(policy.ref)).resolves.toEqual(policy);
  });

  it("fsyncs a policy directory where supported", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-plan-policy-sync-"));

    await expect(fsyncPolicyDirectory(root)).resolves.toBeUndefined();
  });

  it("does not swallow unexpected directory fsync errors", async () => {
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });

    await expect(fsyncPolicyDirectory("unused", async () => {
      throw denied;
    })).rejects.toBe(denied);
  });

  it("only tolerates an unsupported directory fsync error on Windows", async () => {
    const unsupported = Object.assign(new Error("directory sync unsupported"), { code: "EPERM" });
    const operation = fsyncPolicyDirectory("unused", async () => ({
      sync: async () => { throw unsupported; },
      close: async () => undefined,
    }));

    if (process.platform === "win32") {
      await expect(operation).resolves.toBeUndefined();
    } else {
      await expect(operation).rejects.toBe(unsupported);
    }
  });

  it("does not mistake a directory open permission failure for unsupported fsync", async () => {
    const denied = Object.assign(new Error("directory open denied"), { code: "EPERM" });

    await expect(fsyncPolicyDirectory("unused", async () => {
      throw denied;
    })).rejects.toBe(denied);
  });
});

interface SeedChildResult {
  status: "seeded" | "conflict" | "error";
  contentHash?: string;
  error?: string;
}

interface SeedChild {
  ready: Promise<void>;
  result: Promise<SeedChildResult>;
}

function runSeedChild(
  root: string,
  startFile: string,
  policy: ReturnType<typeof createPlanPolicy>,
): SeedChild {
  const moduleUrl = pathToFileURL(path.resolve("src/server/tickets/plan-policy-store.ts")).href;
  const script = `
    import { existsSync } from "node:fs";
    import { setTimeout as delay } from "node:timers/promises";
    const { PlanPolicyConflictError, PlanPolicyStore } = await import(process.env.POLICY_MODULE_URL);
    console.log("READY");
    while (!existsSync(process.env.START_FILE)) await delay(2);
    try {
      await new PlanPolicyStore(process.env.POLICY_ROOT).seedPolicy(JSON.parse(process.env.POLICY_JSON));
      console.log(JSON.stringify({ status: "seeded", contentHash: JSON.parse(process.env.POLICY_JSON).ref.contentHash }));
    } catch (error) {
      console.log(JSON.stringify({
        status: error instanceof PlanPolicyConflictError ? "conflict" : "error",
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  `;
  let markReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    rejectReady = reject;
  });
  const result = new Promise<SeedChildResult>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        POLICY_MODULE_URL: moduleUrl,
        POLICY_ROOT: root,
        POLICY_JSON: JSON.stringify(policy),
        START_FILE: startFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("READY\n") || stdout.includes("READY\r\n")) markReady();
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      rejectReady(error);
      reject(error);
    });
    child.once("exit", (code) => {
      if (code !== 0) {
        const error = new Error(`Seed child exited ${code}: ${stderr}`);
        rejectReady(error);
        return reject(error);
      }
      try {
        const jsonLine = stdout.trim().split(/\r?\n/).at(-1) ?? "";
        resolve(JSON.parse(jsonLine) as SeedChildResult);
      } catch {
        reject(new Error(`Invalid seed child output: ${stdout}\n${stderr}`));
      }
    });
  });
  return { ready, result };
}
