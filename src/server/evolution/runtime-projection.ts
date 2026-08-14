import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { ActiveReleasePointer, SkillArtifactManifest } from "../../shared/contracts/evolution.js";
import type { AgentProfile, WorkspaceAgent } from "../../shared/types.js";
import { MemoryLifecycleStore } from "./memory-lifecycle-store.js";

interface ReleaseManifest {
  schemaVersion: 1;
  release: { id: string; version: string; contentHash: string };
  stage: "canary" | "production";
  candidateId: string;
  candidateHash: string;
  candidateKind: "skill" | "memory";
  target: string;
  artifactRef: string;
  artifactManifestRef?: string;
  artifactManifestHash?: string;
  scope: ActiveReleasePointer["scope"];
  promotionId: string;
  runtimeActive: true;
  validationPassed: boolean;
  validationChecks: Array<{ name: string; passed: boolean; message: string }>;
}

export interface RuntimeEvolutionSkill {
  name: string;
  directory: string;
  releaseId: string;
  contentHash: string;
}

export interface RuntimeEvolutionMemory {
  target: string;
  content: string;
  releaseId: string;
  contentHash: string;
  sourceWorkspaceId?: string;
  layer?: "workspace" | "organization";
}

export interface OrganizationMemorySource {
  workspaceId: string;
  workspaceRoot: string;
  organizationId: string;
}

export interface RuntimeEvolutionProjection {
  skills: RuntimeEvolutionSkill[];
  memories: RuntimeEvolutionMemory[];
  canaryReleases: Array<{ target: string; releaseId: string; contentHash: string }>;
  canaryAssignments: Array<{ target: string; promotionId: string; releaseId: string; selected: boolean }>;
  organizationConflicts: string[];
}
export interface RuntimeEvolutionContext {
  assignmentKey: string;
  taskType?: string;
  tools?: string[];
  organizationMemorySources?: OrganizationMemorySource[];
}

export async function productionEvolutionSkills(
  workspaceRoot: string,
  workspaceId: string,
  profile: AgentProfile,
  agent: WorkspaceAgent,
  context?: Omit<RuntimeEvolutionContext, "assignmentKey">,
): Promise<RuntimeEvolutionSkill[]> {
  return evolutionSkillsForStage(workspaceRoot, workspaceId, profile, agent, "production", undefined, context);
}

async function evolutionSkillsForStage(
  workspaceRoot: string,
  workspaceId: string,
  profile: AgentProfile,
  agent: WorkspaceAgent,
  stage: "canary" | "production",
  assignmentKey?: string,
  context?: Omit<RuntimeEvolutionContext, "assignmentKey">,
): Promise<RuntimeEvolutionSkill[]> {
  const activeDir = path.join(workspaceRoot, ".autoagent", "evolution", "active", stage);
  let files: string[];
  try { files = (await readdir(activeDir)).filter((file) => file.endsWith(".json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const projected: RuntimeEvolutionSkill[] = [];
  for (const file of files.sort()) {
    const pointer = parsePointer(await readFile(path.join(activeDir, file), "utf8"), stage);
    if (!pointer?.active || !pointer.release || !matchesScope(pointer, workspaceId, profile, agent, context) || !selected(pointer, assignmentKey)) continue;
    const manifestFile = safeResolve(workspaceRoot, path.join(".autoagent", "evolution", "releases", pointer.release.id, "manifest.json"));
    const manifest = parseRelease(await readFile(manifestFile, "utf8"));
    if (manifest.release.id !== pointer.release.id || manifest.release.contentHash !== pointer.release.contentHash || manifest.promotionId !== pointer.promotionId
      || manifest.stage !== stage || !manifest.runtimeActive || !manifest.validationPassed || manifest.candidateKind !== "skill" || !sameScope(manifest.scope, pointer.scope)) continue;
    const label = stage === "production" ? "Production" : "Canary";
    if (!manifest.artifactManifestRef || !manifest.artifactManifestHash) throw new Error(`${label} Skill release ${manifest.release.id} has no scanner manifest`);
    const scannerManifest = parseSkillManifest(await readFile(safeResolve(workspaceRoot, path.join(".autoagent", "evolution", manifest.artifactManifestRef)), "utf8"));
    if (scannerManifest.name !== manifest.target || !manifest.release.version.startsWith(scannerManifest.version)
      || !sameScope(scannerManifest.scope, manifest.scope) || canonical(scannerManifest.requiredTools) !== canonical([...(manifest.scope.tools ?? [])].sort())
      || scannerManifest.contentHash !== manifest.candidateHash || scannerManifest.files.length !== 1 || scannerManifest.files[0]?.path !== "SKILL.md"
      || scannerManifest.files[0]?.sha256 !== manifest.candidateHash || scannerManifest.compatibility.runtime !== "autoagent"
      || scannerManifest.compatibility.manifestVersion !== 1 || hash(canonical(scannerManifest)) !== manifest.artifactManifestHash
      || scannerManifest.scanner.candidateHash !== manifest.candidateHash || scannerManifest.scanner.decision !== "pass") {
      throw new Error(`${label} Skill release ${manifest.release.id} failed scanner provenance verification`);
    }
    const skillFile = safeResolve(workspaceRoot, path.join(".autoagent", "evolution", "artifacts", manifest.candidateHash, "SKILL.md"));
    const content = await readFile(skillFile, "utf8");
    if (hash(content) !== manifest.candidateHash) throw new Error(`${label} Skill release ${manifest.release.id} failed content verification`);
    projected.push({ name: manifest.target, directory: path.dirname(skillFile), releaseId: manifest.release.id, contentHash: manifest.candidateHash });
  }
  return projected.sort((left, right) => left.name.localeCompare(right.name));
}

export async function productionEvolutionMemories(
  workspaceRoot: string,
  workspaceId: string,
  profile: AgentProfile,
  agent: WorkspaceAgent,
  context?: Omit<RuntimeEvolutionContext, "assignmentKey">,
): Promise<RuntimeEvolutionMemory[]> {
  return evolutionMemoriesForStage(workspaceRoot, workspaceId, profile, agent, "production", undefined, context);
}

async function evolutionMemoriesForStage(
  workspaceRoot: string,
  workspaceId: string,
  profile: AgentProfile,
  agent: WorkspaceAgent,
  stage: "canary" | "production",
  assignmentKey?: string,
  context?: Omit<RuntimeEvolutionContext, "assignmentKey">,
  storageWorkspaceId = workspaceId,
  organizationSource?: OrganizationMemorySource,
): Promise<RuntimeEvolutionMemory[]> {
  const activeDir = path.join(workspaceRoot, ".autoagent", "evolution", "active", stage);
  let files: string[];
  try { files = (await readdir(activeDir)).filter((file) => file.endsWith(".json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const projected: RuntimeEvolutionMemory[] = [];
  const lifecycle = new MemoryLifecycleStore(storageWorkspaceId, workspaceRoot);
  for (const file of files.sort()) {
    const pointer = parsePointer(await readFile(path.join(activeDir, file), "utf8"), stage);
    if (!pointer?.active || !pointer.release || !matchesScope(pointer, workspaceId, profile, agent, context, organizationSource) || !selected(pointer, assignmentKey)) continue;
    const manifest = parseRelease(await readFile(safeResolve(workspaceRoot, path.join(".autoagent", "evolution", "releases", pointer.release.id, "manifest.json")), "utf8"));
    if (manifest.release.id !== pointer.release.id || manifest.release.contentHash !== pointer.release.contentHash || manifest.promotionId !== pointer.promotionId
      || manifest.stage !== stage || !manifest.runtimeActive || !manifest.validationPassed || manifest.candidateKind !== "memory" || !sameScope(manifest.scope, pointer.scope)) continue;
    if (stage === "production") {
      const memoryState = await lifecycle.get(manifest.release.id);
      if (!memoryState || memoryState.status !== "active") continue;
    }
    const label = stage === "production" ? "Production" : "Canary";
    if (!manifest.validationChecks.some((check) => check.name === "memory_safety" && check.passed)) throw new Error(`${label} Memory release ${manifest.release.id} has no safety validation`);
    const artifactFile = safeResolve(workspaceRoot, path.join(".autoagent", "evolution", manifest.artifactRef));
    const content = await readFile(artifactFile, "utf8");
    if (hash(content) !== manifest.candidateHash) throw new Error(`${label} Memory release ${manifest.release.id} failed content verification`);
    projected.push({
      target: manifest.target, content, releaseId: manifest.release.id, contentHash: manifest.candidateHash,
      ...(organizationSource ? { sourceWorkspaceId: storageWorkspaceId, layer: "organization" as const } : {}),
    });
  }
  return projected.sort((left, right) => left.target.localeCompare(right.target)).slice(0, 20);
}

export async function runtimeEvolutionProjection(
  workspaceRoot: string,
  workspaceId: string,
  profile: AgentProfile,
  agent: WorkspaceAgent,
  context: RuntimeEvolutionContext,
): Promise<RuntimeEvolutionProjection> {
  const [productionSkills, localProductionMemories, canarySkills, canaryMemories, organizationMemorySets] = await Promise.all([
    evolutionSkillsForStage(workspaceRoot, workspaceId, profile, agent, "production", undefined, context),
    evolutionMemoriesForStage(workspaceRoot, workspaceId, profile, agent, "production", undefined, context),
    evolutionSkillsForStage(workspaceRoot, workspaceId, profile, agent, "canary", context.assignmentKey, context),
    evolutionMemoriesForStage(workspaceRoot, workspaceId, profile, agent, "canary", context.assignmentKey, context),
    Promise.all((context.organizationMemorySources ?? []).map((source) => evolutionMemoriesForStage(
      source.workspaceRoot, workspaceId, profile, agent, "production", undefined, context, source.workspaceId, source,
    ))),
  ]);
  const { memories: organizationMemories, conflicts: organizationConflicts } = resolveOrganizationMemoryConflicts(organizationMemorySets.flat());
  const productionMemories = overlayBy(organizationMemories, localProductionMemories, (item) => item.target);
  const canaryAssignments = await matchingCanaryAssignments(workspaceRoot, workspaceId, profile, agent, context);
  const skills = overlayBy(productionSkills, canarySkills, (item) => item.name);
  const memories = overlayBy(productionMemories, canaryMemories, (item) => item.target).slice(0, 20);
  return {
    skills,
    memories,
    canaryReleases: [
      ...canarySkills.map((item) => ({ target: item.name, releaseId: item.releaseId, contentHash: item.contentHash })),
      ...canaryMemories.map((item) => ({ target: item.target, releaseId: item.releaseId, contentHash: item.contentHash })),
    ].sort((left, right) => left.target.localeCompare(right.target)),
    canaryAssignments,
    organizationConflicts,
  };
}

async function matchingCanaryAssignments(
  workspaceRoot: string, workspaceId: string, profile: AgentProfile, agent: WorkspaceAgent, context: RuntimeEvolutionContext,
): Promise<RuntimeEvolutionProjection["canaryAssignments"]> {
  const activeDir = path.join(workspaceRoot, ".autoagent", "evolution", "active", "canary");
  let files: string[];
  try { files = (await readdir(activeDir)).filter((file) => file.endsWith(".json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const assignments: RuntimeEvolutionProjection["canaryAssignments"] = [];
  for (const file of files.sort()) {
    const pointer = parsePointer(await readFile(path.join(activeDir, file), "utf8"), "canary");
    if (!pointer?.active || !pointer.release || !pointer.promotionId || !pointer.rollout || !matchesScope(pointer, workspaceId, profile, agent, context)) continue;
    const manifest = parseRelease(await readFile(safeResolve(workspaceRoot, path.join(".autoagent", "evolution", "releases", pointer.release.id, "manifest.json")), "utf8"));
    if (manifest.stage !== "canary" || manifest.release.id !== pointer.release.id || manifest.release.contentHash !== pointer.release.contentHash
      || manifest.promotionId !== pointer.promotionId || !manifest.runtimeActive || !manifest.validationPassed || !sameScope(manifest.scope, pointer.scope)) continue;
    assignments.push({
      target: pointer.target, promotionId: pointer.promotionId, releaseId: pointer.release.id,
      selected: isCanaryAssignment(pointer.rollout, context.assignmentKey),
    });
  }
  return assignments.sort((left, right) => left.target.localeCompare(right.target));
}

function parsePointer(raw: string, stage: "canary" | "production"): ActiveReleasePointer | undefined {
  const value = JSON.parse(raw) as ActiveReleasePointer;
  if (value?.schemaVersion !== 1 || value.stage !== stage || typeof value.target !== "string" || typeof value.generation !== "number") return undefined;
  return value;
}
function parseRelease(raw: string): ReleaseManifest {
  const value = JSON.parse(raw) as ReleaseManifest;
  if (value?.schemaVersion !== 1 || !value.release?.id || !value.candidateHash || !value.target || !value.artifactRef) throw new Error("Production release manifest is invalid");
  return value;
}
function parseSkillManifest(raw: string): SkillArtifactManifest {
  const value = JSON.parse(raw) as SkillArtifactManifest;
  if (value?.schemaVersion !== 1 || value.kind !== "skill" || !value.name || !value.version || value.entrypoint !== "SKILL.md"
    || !value.scope?.workspaceId || !Array.isArray(value.requiredTools) || !value.riskLevel || !Array.isArray(value.sourceRefs)
    || !Array.isArray(value.files) || !value.compatibility || !value.scanner) throw new Error("Production Skill scanner manifest is invalid");
  return value;
}
function matchesScope(
  pointer: ActiveReleasePointer,
  workspaceId: string,
  profile: AgentProfile,
  agent: WorkspaceAgent,
  context?: Omit<RuntimeEvolutionContext, "assignmentKey">,
  organizationSource?: OrganizationMemorySource,
): boolean {
  const identityMatches = pointer.scope.workspaceId === workspaceId || Boolean(
    organizationSource
    && pointer.scope.workspaceId === organizationSource.workspaceId
    && pointer.scope.organization?.id === organizationSource.organizationId
    && pointer.scope.organization.workspaceIds.includes(workspaceId),
  );
  return identityMatches
    && (!pointer.scope.roles?.length || pointer.scope.roles.includes(agent.roleInWorkspace))
    && (!pointer.scope.providers?.length || pointer.scope.providers.includes(agent.provider ?? profile.defaultProvider))
    && (!pointer.scope.models?.length || pointer.scope.models.includes(agent.model ?? profile.defaultModel))
    && (!pointer.scope.taskTypes?.length || Boolean(context?.taskType && pointer.scope.taskTypes.includes(context.taskType)))
    && (!pointer.scope.tools?.length || pointer.scope.tools.every((tool) => context?.tools?.includes(tool)));
}

export function resolveOrganizationMemoryConflicts(values: RuntimeEvolutionMemory[]): { memories: RuntimeEvolutionMemory[]; conflicts: string[] } {
  const byTarget = new Map<string, RuntimeEvolutionMemory[]>();
  for (const value of values) byTarget.set(value.target, [...(byTarget.get(value.target) ?? []), value]);
  const conflicts = [...byTarget.entries()].filter(([, items]) => new Set(items.map((item) => item.contentHash)).size > 1).map(([target]) => target).sort();
  const conflictSet = new Set(conflicts);
  return {
    memories: [...byTarget.entries()].filter(([target]) => !conflictSet.has(target)).map(([, items]) => items[0]!).sort((a, b) => a.target.localeCompare(b.target)),
    conflicts,
  };
}
function selected(pointer: ActiveReleasePointer, assignmentKey?: string): boolean {
  if (pointer.stage === "production") return true;
  if (!assignmentKey || !pointer.rollout || !Number.isInteger(pointer.rollout.percentage) || pointer.rollout.percentage < 1 || pointer.rollout.percentage > 25 || !pointer.rollout.salt) return false;
  return isCanaryAssignment(pointer.rollout, assignmentKey);
}
export function isCanaryAssignment(rollout: { percentage: number; salt: string }, assignmentKey: string): boolean {
  const bucket = Number.parseInt(hash(`${rollout.salt}\0${assignmentKey}`).slice(0, 8), 16) % 100;
  return bucket < rollout.percentage;
}
function overlayBy<T>(baseline: T[], canary: T[], key: (item: T) => string): T[] {
  const values = new Map(baseline.map((item) => [key(item), item]));
  for (const item of canary) values.set(key(item), item);
  return [...values.values()].sort((left, right) => key(left).localeCompare(key(right)));
}
function sameScope(left: ActiveReleasePointer["scope"], right: ActiveReleasePointer["scope"]): boolean {
  return canonical(left) === canonical(right);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function safeResolve(workspaceRoot: string, relative: string): string {
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error("Evolution runtime projection escaped the workspace");
  return resolved;
}
function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
