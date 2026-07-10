import { createHash } from "node:crypto";
import path from "node:path";
import type {
  WorkflowAuthorizationGrant,
  WorkflowAuthorizationPolicy,
  WorkflowPolicyPort,
  WorkflowPolicyRef,
} from "../../shared/contracts/ticket-engine.js";
import { readJson, writeJson } from "../storage/json.js";

export interface WorkflowPolicySeed {
  policyId: string;
  policyVersion: number;
  grants: WorkflowAuthorizationGrant[];
}

export interface WorkflowCapabilitySubject {
  principalId: string;
  teamBindingIds: string[];
}

export class WorkflowPolicyIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowPolicyIntegrityError";
  }
}

export class WorkflowPolicyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowPolicyConflictError";
  }
}

export class WorkflowPolicyNotFoundError extends Error {
  constructor(ref: WorkflowPolicyRef) {
    super(`Workflow policy not found: ${policyIdentity(ref)}`);
    this.name = "WorkflowPolicyNotFoundError";
  }
}

const seedQueues = new Map<string, Promise<unknown>>();

export class WorkflowPolicyStore implements WorkflowPolicyPort {
  constructor(private readonly rootDir: string) {}

  async seedPolicy(policy: WorkflowAuthorizationPolicy): Promise<WorkflowAuthorizationPolicy> {
    validateRef(policy.ref);
    const normalized = normalizePolicy(policy);
    assertContentHash(normalized);
    const filePath = this.policyFile(normalized.ref);

    return enqueueSeed(filePath, async () => {
      const existing = await readJson<WorkflowAuthorizationPolicy | undefined>(filePath, undefined);
      if (existing) {
        const normalizedExisting = normalizePolicy(existing);
        assertContentHash(normalizedExisting);
        if (normalizedExisting.ref.contentHash !== normalized.ref.contentHash) {
          throw new WorkflowPolicyConflictError(
            `Workflow policy version is immutable: ${policyIdentity(normalized.ref)}`,
          );
        }
        return normalizedExisting;
      }

      await writeJson(filePath, normalized);
      return normalized;
    });
  }

  async getPolicy(ref: WorkflowPolicyRef): Promise<WorkflowAuthorizationPolicy | undefined> {
    validateRef(ref);
    const stored = await readJson<WorkflowAuthorizationPolicy | undefined>(this.policyFile(ref), undefined);
    if (!stored) return undefined;

    const normalized = normalizePolicy(stored);
    assertContentHash(normalized);
    if (normalized.ref.contentHash !== ref.contentHash) {
      throw new WorkflowPolicyIntegrityError(
        `Workflow policy contentHash does not match requested ref: ${policyIdentity(ref)}`,
      );
    }
    return normalized;
  }

  async requirePolicy(ref: WorkflowPolicyRef): Promise<WorkflowAuthorizationPolicy> {
    const policy = await this.getPolicy(ref);
    if (!policy) throw new WorkflowPolicyNotFoundError(ref);
    return policy;
  }

  async hasCapability(
    ref: WorkflowPolicyRef,
    subject: WorkflowCapabilitySubject,
    capability: string,
  ): Promise<boolean> {
    const policy = await this.requirePolicy(ref);
    const teamBindingIds = new Set(subject.teamBindingIds);
    return policy.grants.some((grant) => (
      grant.capabilities.includes(capability)
      && (grant.principalId === subject.principalId
        || (grant.teamBindingId !== undefined && teamBindingIds.has(grant.teamBindingId)))
    ));
  }

  private policyFile(ref: Pick<WorkflowPolicyRef, "policyId" | "policyVersion">): string {
    return path.join(this.rootDir, "workflow-policies", ref.policyId, `${ref.policyVersion}.json`);
  }
}

export function createWorkflowPolicy(seed: WorkflowPolicySeed): WorkflowAuthorizationPolicy {
  validatePolicyIdentity(seed.policyId, seed.policyVersion);
  const grants = normalizeGrants(seed.grants);
  return {
    ref: {
      policyId: seed.policyId,
      policyVersion: seed.policyVersion,
      contentHash: computeContentHash(seed.policyId, seed.policyVersion, grants),
    },
    grants,
  };
}

function normalizePolicy(policy: WorkflowAuthorizationPolicy): WorkflowAuthorizationPolicy {
  validateRef(policy.ref);
  return {
    ref: { ...policy.ref },
    grants: normalizeGrants(policy.grants),
  };
}

function normalizeGrants(grants: WorkflowAuthorizationGrant[]): WorkflowAuthorizationGrant[] {
  return grants.map((grant) => {
    const hasPrincipal = typeof grant.principalId === "string" && grant.principalId.length > 0;
    const hasTeamBinding = typeof grant.teamBindingId === "string" && grant.teamBindingId.length > 0;
    if (hasPrincipal === hasTeamBinding) {
      throw new WorkflowPolicyIntegrityError(
        "Each workflow policy grant must identify exactly one principal or team binding",
      );
    }
    if (grant.capabilities.length === 0 || grant.capabilities.some((value) => !value)) {
      throw new WorkflowPolicyIntegrityError("Workflow policy grants require non-empty capabilities");
    }
    return {
      ...(hasPrincipal ? { principalId: grant.principalId } : { teamBindingId: grant.teamBindingId }),
      capabilities: [...new Set(grant.capabilities)].sort(),
    };
  }).sort((left, right) => grantSortKey(left).localeCompare(grantSortKey(right)));
}

function assertContentHash(policy: WorkflowAuthorizationPolicy): void {
  const expected = computeContentHash(policy.ref.policyId, policy.ref.policyVersion, policy.grants);
  if (policy.ref.contentHash !== expected) {
    throw new WorkflowPolicyIntegrityError(
      `Workflow policy contentHash mismatch: ${policyIdentity(policy.ref)}`,
    );
  }
}

function computeContentHash(
  policyId: string,
  policyVersion: number,
  grants: WorkflowAuthorizationGrant[],
): string {
  const content = JSON.stringify({ policyId, policyVersion, grants });
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function validateRef(ref: WorkflowPolicyRef): void {
  validatePolicyIdentity(ref.policyId, ref.policyVersion);
  if (!/^sha256:[a-f0-9]{64}$/.test(ref.contentHash)) {
    throw new WorkflowPolicyIntegrityError(`Invalid workflow policy contentHash: ${ref.contentHash}`);
  }
}

function validatePolicyIdentity(policyId: string, policyVersion: number): void {
  if (!/^[A-Za-z0-9._-]+$/.test(policyId)) {
    throw new WorkflowPolicyIntegrityError(`Invalid workflow policy id: ${policyId}`);
  }
  if (!Number.isSafeInteger(policyVersion) || policyVersion < 1) {
    throw new WorkflowPolicyIntegrityError(`Invalid workflow policy version: ${policyVersion}`);
  }
}

function grantSortKey(grant: WorkflowAuthorizationGrant): string {
  return `${grant.principalId ? "principal" : "team"}:${grant.principalId ?? grant.teamBindingId}`;
}

function policyIdentity(ref: Pick<WorkflowPolicyRef, "policyId" | "policyVersion">): string {
  return `${ref.policyId}@${ref.policyVersion}`;
}

async function enqueueSeed<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const normalizedKey = path.resolve(key).toLowerCase();
  const previous = seedQueues.get(normalizedKey) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  seedQueues.set(normalizedKey, next);
  try {
    return await next;
  } finally {
    if (seedQueues.get(normalizedKey) === next) seedQueues.delete(normalizedKey);
  }
}
