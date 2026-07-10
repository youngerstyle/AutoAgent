import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import type {
  WorkflowAuthorizationGrant,
  WorkflowAuthorizationPolicy,
  WorkflowPolicyPort,
  WorkflowPolicyRef,
} from "../../shared/contracts/ticket-engine.js";
import { readJson } from "../storage/json.js";

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

export class WorkflowPolicyStore implements WorkflowPolicyPort {
  constructor(private readonly rootDir: string) {}

  async seedPolicy(policy: WorkflowAuthorizationPolicy): Promise<WorkflowAuthorizationPolicy> {
    validateRef(policy.ref);
    const normalized = normalizePolicy(policy);
    assertContentHash(normalized);
    const filePath = this.policyFile(normalized.ref);

    if (await createJsonFileIfAbsent(filePath, normalized)) return normalized;

    const existing = await readJson<WorkflowAuthorizationPolicy | undefined>(filePath, undefined);
    if (!existing) {
      throw new WorkflowPolicyIntegrityError(
        `Workflow policy disappeared after create conflict: ${policyIdentity(normalized.ref)}`,
      );
    }
    const normalizedExisting = normalizePolicy(existing);
    assertContentHash(normalizedExisting);
    if (normalizedExisting.ref.contentHash !== normalized.ref.contentHash) {
      throw new WorkflowPolicyConflictError(
        `Workflow policy version is immutable: ${policyIdentity(normalized.ref)}`,
      );
    }
    return normalizedExisting;
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
    return (await this.capabilitiesFor(ref, subject)).includes(capability);
  }

  async capabilitiesFor(
    ref: WorkflowPolicyRef,
    subject: WorkflowCapabilitySubject,
  ): Promise<string[]> {
    const policy = await this.requirePolicy(ref);
    const teamBindingIds = new Set(subject.teamBindingIds);
    return [...new Set(policy.grants.flatMap((grant) => (
      grant.principalId === subject.principalId
        || (grant.teamBindingId !== undefined && teamBindingIds.has(grant.teamBindingId))
        ? grant.capabilities
        : []
    )))].sort();
  }

  private policyFile(ref: Pick<WorkflowPolicyRef, "policyId" | "policyVersion">): string {
    const policyRoot = path.resolve(this.rootDir, "workflow-policies");
    const policyDirectory = path.resolve(policyRoot, ref.policyId);
    if (!isContainedPath(policyRoot, policyDirectory)) {
      throw new WorkflowPolicyIntegrityError(`Workflow policy path escapes policy root: ${ref.policyId}`);
    }
    return path.resolve(policyDirectory, `${ref.policyVersion}.json`);
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
    ref: {
      policyId: policy.ref.policyId,
      policyVersion: policy.ref.policyVersion,
      contentHash: policy.ref.contentHash,
    },
    grants: normalizeGrants(policy.grants),
  };
}

function normalizeGrants(grants: WorkflowAuthorizationGrant[]): WorkflowAuthorizationGrant[] {
  const bySubject = new Map<string, { grant: WorkflowAuthorizationGrant; capabilities: Set<string> }>();
  for (const grant of grants) {
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
    const normalizedGrant: WorkflowAuthorizationGrant = {
      ...(hasPrincipal ? { principalId: grant.principalId } : { teamBindingId: grant.teamBindingId }),
      capabilities: [],
    };
    const key = grantSortKey(normalizedGrant);
    const entry = bySubject.get(key) ?? { grant: normalizedGrant, capabilities: new Set<string>() };
    for (const capability of grant.capabilities) entry.capabilities.add(capability);
    bySubject.set(key, entry);
  }
  return [...bySubject.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, entry]) => ({ ...entry.grant, capabilities: [...entry.capabilities].sort() }));
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
  const content = JSON.stringify({
    ref: { policyId, policyVersion },
    grants,
  });
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function validateRef(ref: WorkflowPolicyRef): void {
  validatePolicyIdentity(ref.policyId, ref.policyVersion);
  if (!/^sha256:[a-f0-9]{64}$/.test(ref.contentHash)) {
    throw new WorkflowPolicyIntegrityError(`Invalid workflow policy contentHash: ${ref.contentHash}`);
  }
}

function validatePolicyIdentity(policyId: string, policyVersion: number): void {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(policyId)) {
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

async function createJsonFileIfAbsent(filePath: string, value: unknown): Promise<boolean> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    try {
      await link(tempPath, filePath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  } finally {
    await handle.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

function isContainedPath(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}
