import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { ActiveReleasePointer, EvolutionAgentProfileArtifact, PluginArtifactManifest, SkillArtifactManifest } from "../../shared/contracts/evolution.js";
import type { AgentProfile, WorkspaceAgent } from "../../shared/types.js";
import { isKnownToolName } from "../../shared/tool-catalog.js";
import { MemoryLifecycleStore } from "./memory-lifecycle-store.js";
import { configuredPluginSandboxProgram } from "./plugin-sandbox-config.js";

interface ReleaseManifest {
  schemaVersion: 1;
  release: { id: string; version: string; contentHash: string };
  stage: "canary" | "production";
  candidateId: string;
  candidateHash: string;
  candidateKind: "skill" | "memory" | "agent_profile" | "prompt" | "workflow" | "runtime_config" | "source_patch" | "plugin" | "harness";
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
  releaseVersion: string;
  contentHash: string;
  generation: number;
  stage: "canary" | "production";
}

export interface RuntimeEvolutionMemory {
  target: string;
  content: string;
  releaseId: string;
  releaseVersion: string;
  contentHash: string;
  generation: number;
  stage: "canary" | "production";
  sourceWorkspaceId?: string;
  layer?: "workspace" | "organization";
}

export interface RuntimeEvolutionExtension {
  name: string;
  kind: "plugin" | "harness";
  directory: string;
  entrypoint: string;
  releaseId: string;
  releaseVersion: string;
  contentHash: string;
  generation: number;
  stage: "canary" | "production";
  manifest: PluginArtifactManifest;
}

export interface RuntimeEvolutionPrompt {
  target: string;
  content: string;
  releaseId: string;
  releaseVersion: string;
  contentHash: string;
  generation: number;
  stage: "canary" | "production";
}

export interface RuntimeEvolutionAgentProfile {
  target: string;
  profile: AgentProfile;
  releaseId: string;
  releaseVersion: string;
  contentHash: string;
  generation: number;
  stage: "canary" | "production";
}

export interface OrganizationMemorySource {
  workspaceId: string;
  workspaceRoot: string;
  organizationId: string;
}

export interface RuntimeEvolutionProjection {
  skills: RuntimeEvolutionSkill[];
  memories: RuntimeEvolutionMemory[];
  plugins: RuntimeEvolutionExtension[];
  harnesses: RuntimeEvolutionExtension[];
  prompts: RuntimeEvolutionPrompt[];
  agentProfiles: RuntimeEvolutionAgentProfile[];
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

export async function runtimeEvolutionStateFingerprint(workspaceRoot: string, organizationSources: OrganizationMemorySource[] = []): Promise<string> {
  const roots = [{ workspaceId: "local", workspaceRoot }, ...organizationSources.map((item) => ({ workspaceId: item.workspaceId, workspaceRoot: item.workspaceRoot }))];
  const values: string[] = [];
  for (const root of roots.sort((a, b) => a.workspaceId.localeCompare(b.workspaceId))) {
    for (const relative of [path.join("active", "canary"), path.join("active", "production")]) {
      const directory = path.join(root.workspaceRoot, ".autoagent", "evolution", relative);
      let files: string[] = [];
      try { files = (await readdir(directory)).filter((file) => file.endsWith(".json")).sort(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      for (const file of files) values.push(`${root.workspaceId}:${relative}:${file}:${await readFile(path.join(directory, file), "utf8")}`);
    }
    const lifecycle = path.join(root.workspaceRoot, ".autoagent", "evolution", "memory-lifecycle.jsonl");
    try { values.push(`${root.workspaceId}:memory-lifecycle:${await readFile(lifecycle, "utf8")}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  values.push(canonical(organizationSources));
  return hash(values.join("\n"));
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
    projected.push({ name: manifest.target, directory: path.dirname(skillFile), releaseId: manifest.release.id, releaseVersion: manifest.release.version, contentHash: manifest.candidateHash, generation: pointer.generation, stage });
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

export async function productionEvolutionExtensions(
  workspaceRoot: string,
  workspaceId: string,
  profile: AgentProfile,
  agent: WorkspaceAgent,
  context?: Omit<RuntimeEvolutionContext, "assignmentKey">,
): Promise<RuntimeEvolutionExtension[]> {
  return evolutionExtensionsForStage(workspaceRoot, workspaceId, profile, agent, "production", undefined, context);
}

async function evolutionExtensionsForStage(
  workspaceRoot: string,
  workspaceId: string,
  profile: AgentProfile,
  agent: WorkspaceAgent,
  stage: "canary" | "production",
  assignmentKey?: string,
  context?: Omit<RuntimeEvolutionContext, "assignmentKey">,
): Promise<RuntimeEvolutionExtension[]> {
  const activeDir = path.join(workspaceRoot, ".autoagent", "evolution", "active", stage);
  let files: string[];
  try { files = (await readdir(activeDir)).filter((file) => file.endsWith(".json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const projected: RuntimeEvolutionExtension[] = [];
  for (const file of files.sort()) {
    const pointer = parsePointer(await readFile(path.join(activeDir, file), "utf8"), stage);
    if (!pointer?.active || !pointer.release || !matchesScope(pointer, workspaceId, profile, agent, context) || !selected(pointer, assignmentKey)) continue;
    const release = parseRelease(await readFile(safeResolve(workspaceRoot, path.join(".autoagent", "evolution", "releases", pointer.release.id, "manifest.json")), "utf8"));
    if (release.release.id !== pointer.release.id || release.release.contentHash !== pointer.release.contentHash || release.promotionId !== pointer.promotionId
      || release.stage !== stage || !release.runtimeActive || !release.validationPassed || !["plugin", "harness"].includes(release.candidateKind) || !sameScope(release.scope, pointer.scope)) continue;
    if (!configuredPluginSandboxProgram()) throw new Error(`Active ${release.candidateKind} release ${release.release.id} requires an operator-configured OS sandbox launcher`);
    const label = stage === "production" ? "Production" : "Canary";
    if (!release.artifactManifestRef || !release.artifactManifestHash) throw new Error(`${label} extension ${release.release.id} has no scanner manifest`);
    const manifest = parsePluginManifest(await readFile(safeResolve(workspaceRoot, path.join(".autoagent", "evolution", release.artifactManifestRef)), "utf8"));
    if (manifest.name !== release.target || manifest.kind !== release.candidateKind || manifest.contentHash !== release.candidateHash
      || !sameScope(manifest.scope, release.scope) || manifest.riskLevel !== "critical" || manifest.compatibility.runtime !== "autoagent"
      || manifest.compatibility.hostApi !== "autoagent.plugin/v1" || manifest.scanner.decision !== "pass"
      || manifest.scanner.candidateHash !== release.candidateHash || hash(canonical(manifest)) !== release.artifactManifestHash) {
      throw new Error(`${label} extension ${release.release.id} failed manifest provenance verification`);
    }
    const directory = safeResolve(workspaceRoot, path.join(".autoagent", "evolution", "artifacts", release.candidateHash, "bundle"));
    for (const item of manifest.files) {
      const content = await readFile(safeResolve(directory, item.path), "utf8");
      if (hash(content) !== item.sha256 || Buffer.byteLength(content, "utf8") !== item.bytes) throw new Error(`${label} extension ${release.release.id} failed file verification`);
    }
    projected.push({
      name: manifest.name, kind: manifest.kind, directory,
      entrypoint: safeResolve(directory, manifest.entrypoint), releaseId: release.release.id, releaseVersion: release.release.version,
      contentHash: release.candidateHash, generation: pointer.generation, stage, manifest,
    });
  }
  return projected.sort((left, right) => left.name.localeCompare(right.name));
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
      target: manifest.target, content, releaseId: manifest.release.id, releaseVersion: manifest.release.version, contentHash: manifest.candidateHash, generation: pointer.generation, stage,
      ...(organizationSource ? { sourceWorkspaceId: storageWorkspaceId, layer: "organization" as const } : {}),
    });
  }
  return projected.sort((left, right) => left.target.localeCompare(right.target)).slice(0, 20);
}

async function evolutionDeclarativeAssetsForStage(
  workspaceRoot: string,
  workspaceId: string,
  profile: AgentProfile,
  agent: WorkspaceAgent,
  stage: "canary" | "production",
  assignmentKey?: string,
  context?: Omit<RuntimeEvolutionContext, "assignmentKey">,
): Promise<{ prompts: RuntimeEvolutionPrompt[]; agentProfiles: RuntimeEvolutionAgentProfile[] }> {
  const activeDir = path.join(workspaceRoot, ".autoagent", "evolution", "active", stage);
  let files: string[];
  try { files = (await readdir(activeDir)).filter((file) => file.endsWith(".json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { prompts: [], agentProfiles: [] }; throw error; }
  const prompts: RuntimeEvolutionPrompt[] = [];
  const agentProfiles: RuntimeEvolutionAgentProfile[] = [];
  for (const file of files.sort()) {
    const pointer = parsePointer(await readFile(path.join(activeDir, file), "utf8"), stage);
    if (!pointer?.active || !pointer.release || !matchesScope(pointer, workspaceId, profile, agent, context) || !selected(pointer, assignmentKey)) continue;
    const release = parseRelease(await readFile(safeResolve(workspaceRoot, path.join(".autoagent", "evolution", "releases", pointer.release.id, "manifest.json")), "utf8"));
    if (release.release.id !== pointer.release.id || release.release.contentHash !== pointer.release.contentHash || release.promotionId !== pointer.promotionId
      || release.stage !== stage || !release.runtimeActive || !release.validationPassed || !["prompt", "agent_profile"].includes(release.candidateKind) || !sameScope(release.scope, pointer.scope)) continue;
    const content = await readFile(safeResolve(workspaceRoot, path.join(".autoagent", "evolution", release.artifactRef)), "utf8");
    if (hash(content) !== release.candidateHash) throw new Error(`${stage} ${release.candidateKind} release ${release.release.id} failed content verification`);
    const common = { target: release.target, releaseId: release.release.id, releaseVersion: release.release.version, contentHash: release.candidateHash, generation: pointer.generation, stage };
    if (release.candidateKind === "prompt") {
      if (!release.validationChecks.some((check) => check.name === "prompt_safety" && check.passed)) throw new Error(`${stage} Prompt release ${release.release.id} has no safety validation`);
      prompts.push({ ...common, content });
    } else {
      if (release.target !== profile.id || !release.validationChecks.some((check) => check.name === "agent_profile_contract" && check.passed)) continue;
      const artifact = parseRuntimeAgentProfileArtifact(content);
      if ((artifact.defaultProvider !== undefined || artifact.defaultModel !== undefined || artifact.defaultPolicy !== undefined)
        && !release.validationChecks.some((check) => check.name === "agent_profile_runtime_authority" && check.passed)) {
        throw new Error(`${stage} Agent Profile release ${release.release.id} has no runtime-authority validation`);
      }
      agentProfiles.push({ ...common, profile: {
        ...profile,
        ...(typeof artifact.identity === "string" ? { identity: artifact.identity } : {}),
        ...(typeof artifact.soul === "string" ? { soul: artifact.soul } : {}),
        ...(typeof artifact.agentMd === "string" ? { agentMd: artifact.agentMd } : {}),
        ...(Array.isArray(artifact.capabilities) ? { capabilities: artifact.capabilities as string[] } : {}),
        ...(Array.isArray(artifact.defaultSkills) ? { defaultSkills: artifact.defaultSkills as string[] } : {}),
        ...(artifact.defaultProvider ? { defaultProvider: artifact.defaultProvider } : {}),
        ...(artifact.defaultModel ? { defaultModel: artifact.defaultModel } : {}),
        ...(artifact.defaultPolicy ? { defaultPolicy: { ...profile.defaultPolicy, ...artifact.defaultPolicy } } : {}),
      } });
    }
  }
  return { prompts: prompts.sort((a, b) => a.target.localeCompare(b.target)), agentProfiles: agentProfiles.sort((a, b) => a.target.localeCompare(b.target)) };
}

export async function evolutionAgentProfileForSession(
  workspaceRoot: string,
  workspaceId: string,
  profile: AgentProfile,
  agent: WorkspaceAgent,
  context: RuntimeEvolutionContext,
): Promise<RuntimeEvolutionAgentProfile | undefined> {
  const [production, canary] = await Promise.all([
    evolutionDeclarativeAssetsForStage(workspaceRoot, workspaceId, profile, agent, "production", undefined, context),
    evolutionDeclarativeAssetsForStage(workspaceRoot, workspaceId, profile, agent, "canary", context.assignmentKey, context),
  ]);
  return overlayBy(production.agentProfiles, canary.agentProfiles, (item) => item.target).find((item) => item.target === profile.id);
}

export async function runtimeEvolutionProjection(
  workspaceRoot: string,
  workspaceId: string,
  profile: AgentProfile,
  agent: WorkspaceAgent,
  context: RuntimeEvolutionContext,
): Promise<RuntimeEvolutionProjection> {
  const [productionSkills, localProductionMemories, productionExtensions, productionDeclarative, canarySkills, canaryMemories, canaryExtensions, canaryDeclarative, organizationMemorySets] = await Promise.all([
    evolutionSkillsForStage(workspaceRoot, workspaceId, profile, agent, "production", undefined, context),
    evolutionMemoriesForStage(workspaceRoot, workspaceId, profile, agent, "production", undefined, context),
    evolutionExtensionsForStage(workspaceRoot, workspaceId, profile, agent, "production", undefined, context),
    evolutionDeclarativeAssetsForStage(workspaceRoot, workspaceId, profile, agent, "production", undefined, context),
    evolutionSkillsForStage(workspaceRoot, workspaceId, profile, agent, "canary", context.assignmentKey, context),
    evolutionMemoriesForStage(workspaceRoot, workspaceId, profile, agent, "canary", context.assignmentKey, context),
    evolutionExtensionsForStage(workspaceRoot, workspaceId, profile, agent, "canary", context.assignmentKey, context),
    evolutionDeclarativeAssetsForStage(workspaceRoot, workspaceId, profile, agent, "canary", context.assignmentKey, context),
    Promise.all((context.organizationMemorySources ?? []).map((source) => evolutionMemoriesForStage(
      source.workspaceRoot, workspaceId, profile, agent, "production", undefined, context, source.workspaceId, source,
    ))),
  ]);
  const { memories: organizationMemories, conflicts: organizationConflicts } = resolveOrganizationMemoryConflicts(organizationMemorySets.flat());
  const productionMemories = overlayBy(organizationMemories, localProductionMemories, (item) => item.target);
  const canaryAssignments = await matchingCanaryAssignments(workspaceRoot, workspaceId, profile, agent, context);
  const skills = overlayBy(productionSkills, canarySkills, (item) => item.name);
  const memories = overlayBy(productionMemories, canaryMemories, (item) => item.target).slice(0, 20);
  const extensions = overlayBy(productionExtensions, canaryExtensions, (item) => `${item.kind}:${item.name}`);
  const prompts = overlayBy(productionDeclarative.prompts, canaryDeclarative.prompts, (item) => item.target);
  const agentProfiles = overlayBy(productionDeclarative.agentProfiles, canaryDeclarative.agentProfiles, (item) => item.target);
  return {
    skills,
    memories,
    plugins: extensions.filter((item) => item.kind === "plugin"),
    harnesses: extensions.filter((item) => item.kind === "harness"),
    prompts,
    agentProfiles,
    canaryReleases: [
      ...canarySkills.map((item) => ({ target: item.name, releaseId: item.releaseId, contentHash: item.contentHash })),
      ...canaryMemories.map((item) => ({ target: item.target, releaseId: item.releaseId, contentHash: item.contentHash })),
      ...canaryExtensions.map((item) => ({ target: item.name, releaseId: item.releaseId, contentHash: item.contentHash })),
      ...canaryDeclarative.prompts.map((item) => ({ target: item.target, releaseId: item.releaseId, contentHash: item.contentHash })),
      ...canaryDeclarative.agentProfiles.map((item) => ({ target: item.target, releaseId: item.releaseId, contentHash: item.contentHash })),
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
function parsePluginManifest(raw: string): PluginArtifactManifest {
  const value = JSON.parse(raw) as PluginArtifactManifest;
  if (value?.schemaVersion !== 1 || !["plugin", "harness"].includes(value.kind) || !value.name || !value.version
    || value.apiVersion !== "autoagent.plugin/v1" || !value.entrypoint || !value.scope?.workspaceId || value.riskLevel !== "critical"
    || !value.permissions || !Array.isArray(value.permissions.workspaceRead) || !value.contributions
    || !Array.isArray(value.contributions.tools) || !Array.isArray(value.contributions.guardrails) || !Array.isArray(value.files)
    || !value.compatibility || !value.scanner) throw new Error("Production Plugin scanner manifest is invalid");
  return value;
}
function parseRuntimeAgentProfileArtifact(raw: string): EvolutionAgentProfileArtifact {
  const value = JSON.parse(raw) as EvolutionAgentProfileArtifact;
  const allowed = new Set(["schemaVersion", "id", "identity", "soul", "agentMd", "capabilities", "defaultSkills", "defaultProvider", "defaultModel", "defaultPolicy"]);
  if (value?.schemaVersion !== 1 || typeof value.id !== "string" || Object.keys(value).some((key) => !allowed.has(key))) throw new Error("Evolution Agent Profile artifact is invalid");
  if (value.defaultProvider !== undefined && !["mock", "openai", "anthropic"].includes(value.defaultProvider)) throw new Error("Evolution Agent Profile provider is invalid");
  if (value.defaultModel !== undefined && (typeof value.defaultModel !== "string" || !value.defaultModel.trim())) throw new Error("Evolution Agent Profile model is invalid");
  if (value.defaultPolicy) {
    const policy = value.defaultPolicy;
    if (policy.enabledTools?.some((tool) => !isKnownToolName(tool)) || policy.commandAllowlist?.some((item) => typeof item !== "string" || !item.trim())) throw new Error("Evolution Agent Profile policy is invalid");
  }
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
