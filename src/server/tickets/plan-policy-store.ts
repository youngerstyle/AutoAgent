import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type {
  PlanAuthorizationGrant,
  PlanAuthorizationPolicy,
  PlanPolicyPort,
  PlanPolicyRef,
} from "../../shared/contracts/ticket-engine.js";
import { readJson } from "../storage/json.js";

export interface PlanPolicySeed {
  policyId: string;
  policyVersion: number;
  grants: PlanAuthorizationGrant[];
}

export interface PlanCapabilitySubject {
  principalId: string;
  teamBindingIds: string[];
}

export class PlanPolicyIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanPolicyIntegrityError";
  }
}

export class PlanPolicyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanPolicyConflictError";
  }
}

export class PlanPolicyNotFoundError extends Error {
  constructor(ref: PlanPolicyRef) {
    super(`Plan policy not found: ${policyIdentity(ref)}`);
    this.name = "PlanPolicyNotFoundError";
  }
}

export class PlanPolicyStore implements PlanPolicyPort {
  constructor(private readonly rootDir: string) {}

  async seedPolicy(policy: PlanAuthorizationPolicy): Promise<PlanAuthorizationPolicy> {
    validateRef(policy.ref);
    const normalized = normalizePolicy(policy);
    assertContentHash(normalized);
    const filePath = this.policyFile(normalized.ref);

    if (await createJsonFileIfAbsent(filePath, normalized)) return normalized;

    const existing = await readJson<PlanAuthorizationPolicy | undefined>(filePath, undefined);
    if (!existing) {
      throw new PlanPolicyIntegrityError(
        `Plan policy disappeared after create conflict: ${policyIdentity(normalized.ref)}`,
      );
    }
    const normalizedExisting = normalizePolicy(existing);
    assertContentHash(normalizedExisting);
    if (normalizedExisting.ref.contentHash !== normalized.ref.contentHash) {
      throw new PlanPolicyConflictError(
        `Plan policy version is immutable: ${policyIdentity(normalized.ref)}`,
      );
    }
    return normalizedExisting;
  }

  async getPolicy(ref: PlanPolicyRef): Promise<PlanAuthorizationPolicy | undefined> {
    validateRef(ref);
    const stored = await readJson<PlanAuthorizationPolicy | undefined>(this.policyFile(ref), undefined);
    if (!stored) return undefined;

    const normalized = normalizePolicy(stored);
    assertContentHash(normalized);
    if (normalized.ref.contentHash !== ref.contentHash) {
      throw new PlanPolicyIntegrityError(
        `Plan policy contentHash does not match requested ref: ${policyIdentity(ref)}`,
      );
    }
    return normalized;
  }

  async requirePolicy(ref: PlanPolicyRef): Promise<PlanAuthorizationPolicy> {
    const policy = await this.getPolicy(ref);
    if (!policy) throw new PlanPolicyNotFoundError(ref);
    return policy;
  }

  async hasCapability(
    ref: PlanPolicyRef,
    subject: PlanCapabilitySubject,
    capability: string,
  ): Promise<boolean> {
    return (await this.capabilitiesFor(ref, subject)).includes(capability);
  }

  async capabilitiesFor(
    ref: PlanPolicyRef,
    subject: PlanCapabilitySubject,
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

  private policyFile(ref: Pick<PlanPolicyRef, "policyId" | "policyVersion">): string {
    const policyRoot = path.resolve(this.rootDir, "plan-policies");
    const policyDirectory = path.resolve(policyRoot, ref.policyId);
    if (!isContainedPath(policyRoot, policyDirectory)) {
      throw new PlanPolicyIntegrityError(`Plan policy path escapes policy root: ${ref.policyId}`);
    }
    return path.resolve(policyDirectory, `${ref.policyVersion}.json`);
  }
}

export function createPlanPolicy(seed: PlanPolicySeed): PlanAuthorizationPolicy {
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

function normalizePolicy(policy: PlanAuthorizationPolicy): PlanAuthorizationPolicy {
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

function normalizeGrants(grants: PlanAuthorizationGrant[]): PlanAuthorizationGrant[] {
  const bySubject = new Map<string, { grant: PlanAuthorizationGrant; capabilities: Set<string> }>();
  for (const grant of grants) {
    const hasPrincipal = typeof grant.principalId === "string" && grant.principalId.length > 0;
    const hasTeamBinding = typeof grant.teamBindingId === "string" && grant.teamBindingId.length > 0;
    if (hasPrincipal === hasTeamBinding) {
      throw new PlanPolicyIntegrityError(
        "Each plan policy grant must identify exactly one principal or team binding",
      );
    }
    if (grant.capabilities.length === 0 || grant.capabilities.some((value) => !value)) {
      throw new PlanPolicyIntegrityError("Plan policy grants require non-empty capabilities");
    }
    const normalizedGrant: PlanAuthorizationGrant = {
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

function assertContentHash(policy: PlanAuthorizationPolicy): void {
  const expected = computeContentHash(policy.ref.policyId, policy.ref.policyVersion, policy.grants);
  if (policy.ref.contentHash !== expected) {
    throw new PlanPolicyIntegrityError(
      `Plan policy contentHash mismatch: ${policyIdentity(policy.ref)}`,
    );
  }
}

function computeContentHash(
  policyId: string,
  policyVersion: number,
  grants: PlanAuthorizationGrant[],
): string {
  const content = JSON.stringify({
    ref: { policyId, policyVersion },
    grants,
  });
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function validateRef(ref: PlanPolicyRef): void {
  validatePolicyIdentity(ref.policyId, ref.policyVersion);
  if (!/^sha256:[a-f0-9]{64}$/.test(ref.contentHash)) {
    throw new PlanPolicyIntegrityError(`Invalid plan policy contentHash: ${ref.contentHash}`);
  }
}

function validatePolicyIdentity(policyId: string, policyVersion: number): void {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(policyId)) {
    throw new PlanPolicyIntegrityError(`Invalid plan policy id: ${policyId}`);
  }
  if (!Number.isSafeInteger(policyVersion) || policyVersion < 1) {
    throw new PlanPolicyIntegrityError(`Invalid plan policy version: ${policyVersion}`);
  }
}

function grantSortKey(grant: PlanAuthorizationGrant): string {
  return `${grant.principalId ? "principal" : "team"}:${grant.principalId ?? grant.teamBindingId}`;
}

function policyIdentity(ref: Pick<PlanPolicyRef, "policyId" | "policyVersion">): string {
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
      await fsyncPolicyDirectory(path.dirname(filePath));
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

type PolicyDirectoryOpener = (
  directory: string,
  flags: "r",
) => Promise<Pick<FileHandle, "sync" | "close">>;

export async function fsyncPolicyDirectory(
  directory: string,
  openDirectory: PolicyDirectoryOpener = open,
): Promise<void> {
  const handle = await openDirectory(directory, "r");
  try {
    await handle.sync();
  } catch (error) {
    if (!isUnsupportedWindowsDirectorySync(error)) throw error;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function isUnsupportedWindowsDirectorySync(error: unknown): boolean {
  if (process.platform !== "win32") return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPERM"
    || code === "EISDIR"
    || code === "EINVAL"
    || code === "ENOTSUP"
    || code === "ENOSYS";
}

function isContainedPath(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}
