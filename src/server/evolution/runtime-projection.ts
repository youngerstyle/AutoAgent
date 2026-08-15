import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { ActiveReleasePointer, EvolutionAgentProfileArtifact, EvolutionOwnerLevel, EvolutionScope, PluginArtifactManifest, SkillArtifactManifest } from "../../shared/contracts/evolution.js";
import type { AgentProfile, WorkspaceAgent } from "../../shared/types.js";
import { isKnownToolName } from "../../shared/tool-catalog.js";
import { MemoryLifecycleStore } from "./memory-lifecycle-store.js";

interface ReleaseManifest {
  schemaVersion: 1;
  release: { id: string; version: string; contentHash: string };
  stage: "canary" | "production";
  candidateId: string;
  candidateHash: string;
  candidateKind: "skill" | "memory" | "agent_profile" | "prompt" | "workflow" | "runtime_config" | "plugin" | "harness";
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
  ownerLevel: EvolutionOwnerLevel;
}

export interface RuntimeEvolutionMemory {
  target: string;
  content: string;
  releaseId: string;
  releaseVersion: string;
  contentHash: string;
  generation: number;
  stage: "canary" | "production";
  ownerLevel: EvolutionOwnerLevel;
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
  ownerLevel: EvolutionOwnerLevel;
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
  ownerLevel: EvolutionOwnerLevel;
}

export interface RuntimeEvolutionAgentProfile {
  target: string;
  profile: AgentProfile;
  releaseId: string;
  releaseVersion: string;
  contentHash: string;
  generation: number;
  stage: "canary" | "production";
  ownerLevel: EvolutionOwnerLevel;
}

export interface OrganizationMemorySource {
  workspaceId: string;
  workspaceRoot: string;
  organizationId: string;
}
export interface SharedEvolutionLayerSource {
  layerRoot: string;
  ownerLevel: "agent" | "company";
  ownerId: string;
  companyId: string;
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
  resolvedReleases: RuntimeEvolutionResolvedRelease[];
  snapshotHash: string;
}
export interface RuntimeEvolutionResolvedRelease {
  assetKind: "skill" | "memory" | "plugin" | "harness" | "prompt" | "agent_profile";
  target: string;
  ownerLevel: EvolutionOwnerLevel;
  releaseRef: { id: string; version: string; contentHash: string };
  generation: number;
  stage: "canary" | "production";
  sourceWorkspaceId?: string;
}
export interface RuntimeEvolutionContext {
  assignmentKey: string;
  taskType?: string;
  tools?: string[];
  organizationMemorySources?: OrganizationMemorySource[];
  sharedReleaseSources?: SharedEvolutionLayerSource[];
}

export async function runtimeEvolutionStateFingerprint(workspaceRoot: string, organizationSources: OrganizationMemorySource[] = [], sharedSources: SharedEvolutionLayerSource[] = []): Promise<string> {
  const roots = [
    { workspaceId: "local", workspaceRoot },
    ...organizationSources.map((item) => ({ workspaceId: `organization:${item.workspaceId}`, workspaceRoot: item.workspaceRoot })),
    ...sharedSources.map((item) => ({ workspaceId: `${item.ownerLevel}:${item.ownerId}`, workspaceRoot: item.layerRoot })),
  ];
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
  values.push(canonical(sharedSources.map((item) => ({ ownerLevel: item.ownerLevel, ownerId: item.ownerId, companyId: item.companyId }))));
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
  sharedSource?: SharedEvolutionLayerSource,
): Promise<RuntimeEvolutionSkill[]> {
  const activeDir = path.join(workspaceRoot, ".autoagent", "evolution", "active", stage);
  let files: string[];
  try { files = (await readdir(activeDir)).filter((file) => file.endsWith(".json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const projected: RuntimeEvolutionSkill[] = [];
  for (const file of files.sort()) {
    const pointer = parsePointer(await readFile(path.join(activeDir, file), "utf8"), stage);
    if (!pointer?.active || !pointer.release || !matchesScope(pointer, workspaceId, profile, agent, context, undefined, sharedSource) || !selected(pointer, assignmentKey)) continue;
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
    projected.push({ name: manifest.target, directory: path.dirname(skillFile), releaseId: manifest.release.id, releaseVersion: manifest.release.version, contentHash: manifest.candidateHash, generation: pointer.generation, stage, ownerLevel: resolvedOwnerLevel(pointer.scope) });
  }
  return resolveEvolutionLayers(projected, (item) => item.name);
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
  sharedSource?: SharedEvolutionLayerSource,
): Promise<RuntimeEvolutionExtension[]> {
  const activeDir = path.join(workspaceRoot, ".autoagent", "evolution", "active", stage);
  let files: string[];
  try { files = (await readdir(activeDir)).filter((file) => file.endsWith(".json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const projected: RuntimeEvolutionExtension[] = [];
  for (const file of files.sort()) {
    const pointer = parsePointer(await readFile(path.join(activeDir, file), "utf8"), stage);
    if (!pointer?.active || !pointer.release || !matchesScope(pointer, workspaceId, profile, agent, context, undefined, sharedSource) || !selected(pointer, assignmentKey)) continue;
    const release = parseRelease(await readFile(safeResolve(workspaceRoot, path.join(".autoagent", "evolution", "releases", pointer.release.id, "manifest.json")), "utf8"));
    if (release.release.id !== pointer.release.id || release.release.contentHash !== pointer.release.contentHash || release.promotionId !== pointer.promotionId
      || release.stage !== stage || !release.runtimeActive || !release.validationPassed || !["plugin", "harness"].includes(release.candidateKind) || !sameScope(release.scope, pointer.scope)) continue;
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
      ownerLevel: resolvedOwnerLevel(pointer.scope),
    });
  }
  return resolveEvolutionLayers(projected, (item) => `${item.kind}:${item.name}`);
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
  sharedSource?: SharedEvolutionLayerSource,
): Promise<RuntimeEvolutionMemory[]> {
  const activeDir = path.join(workspaceRoot, ".autoagent", "evolution", "active", stage);
  let files: string[];
  try { files = (await readdir(activeDir)).filter((file) => file.endsWith(".json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const projected: RuntimeEvolutionMemory[] = [];
  const lifecycle = new MemoryLifecycleStore(storageWorkspaceId, workspaceRoot);
  for (const file of files.sort()) {
    const pointer = parsePointer(await readFile(path.join(activeDir, file), "utf8"), stage);
    if (!pointer?.active || !pointer.release || !matchesScope(pointer, workspaceId, profile, agent, context, organizationSource, sharedSource) || !selected(pointer, assignmentKey)) continue;
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
      ownerLevel: resolvedOwnerLevel(pointer.scope, Boolean(organizationSource)),
      ...(organizationSource ? { sourceWorkspaceId: storageWorkspaceId, layer: "organization" as const } : {}),
    });
  }
  return resolveEvolutionLayers(projected, (item) => item.target).slice(0, 20);
}

async function evolutionDeclarativeAssetsForStage(
  workspaceRoot: string,
  workspaceId: string,
  profile: AgentProfile,
  agent: WorkspaceAgent,
  stage: "canary" | "production",
  assignmentKey?: string,
  context?: Omit<RuntimeEvolutionContext, "assignmentKey">,
  sharedSource?: SharedEvolutionLayerSource,
): Promise<{ prompts: RuntimeEvolutionPrompt[]; agentProfiles: RuntimeEvolutionAgentProfile[] }> {
  const activeDir = path.join(workspaceRoot, ".autoagent", "evolution", "active", stage);
  let files: string[];
  try { files = (await readdir(activeDir)).filter((file) => file.endsWith(".json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { prompts: [], agentProfiles: [] }; throw error; }
  const prompts: RuntimeEvolutionPrompt[] = [];
  const agentProfiles: RuntimeEvolutionAgentProfile[] = [];
  for (const file of files.sort()) {
    const pointer = parsePointer(await readFile(path.join(activeDir, file), "utf8"), stage);
    if (!pointer?.active || !pointer.release || !matchesScope(pointer, workspaceId, profile, agent, context, undefined, sharedSource) || !selected(pointer, assignmentKey)) continue;
    const release = parseRelease(await readFile(safeResolve(workspaceRoot, path.join(".autoagent", "evolution", "releases", pointer.release.id, "manifest.json")), "utf8"));
    if (release.release.id !== pointer.release.id || release.release.contentHash !== pointer.release.contentHash || release.promotionId !== pointer.promotionId
      || release.stage !== stage || !release.runtimeActive || !release.validationPassed || !["prompt", "agent_profile"].includes(release.candidateKind) || !sameScope(release.scope, pointer.scope)) continue;
    const content = await readFile(safeResolve(workspaceRoot, path.join(".autoagent", "evolution", release.artifactRef)), "utf8");
    if (hash(content) !== release.candidateHash) throw new Error(`${stage} ${release.candidateKind} release ${release.release.id} failed content verification`);
    const common = { target: release.target, releaseId: release.release.id, releaseVersion: release.release.version, contentHash: release.candidateHash, generation: pointer.generation, stage, ownerLevel: resolvedOwnerLevel(pointer.scope) };
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
  return { prompts: resolveEvolutionLayers(prompts, (item) => item.target), agentProfiles: resolveEvolutionLayers(agentProfiles, (item) => item.target) };
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
  return resolveEvolutionLayers([...production.agentProfiles, ...canary.agentProfiles], (item) => item.target).find((item) => item.target === profile.id);
}

export async function runtimeEvolutionProjection(
  workspaceRoot: string,
  workspaceId: string,
  profile: AgentProfile,
  agent: WorkspaceAgent,
  context: RuntimeEvolutionContext,
): Promise<RuntimeEvolutionProjection> {
  const sharedSetsPromise = Promise.all((context.sharedReleaseSources ?? []).map(async (source) => {
    const storageWorkspaceId = `shared:${source.ownerLevel}:${source.ownerId}`;
    const [skills, memories, extensions, declarative] = await Promise.all([
      evolutionSkillsForStage(source.layerRoot, workspaceId, profile, agent, "production", undefined, context, source),
      evolutionMemoriesForStage(source.layerRoot, workspaceId, profile, agent, "production", undefined, context, storageWorkspaceId, undefined, source),
      evolutionExtensionsForStage(source.layerRoot, workspaceId, profile, agent, "production", undefined, context, source),
      evolutionDeclarativeAssetsForStage(source.layerRoot, workspaceId, profile, agent, "production", undefined, context, source),
    ]);
    return { skills, memories, extensions, declarative };
  }));
  const [localProductionSkills, localProductionMemories, localProductionExtensions, localProductionDeclarative, canarySkills, canaryMemories, canaryExtensions, canaryDeclarative, organizationMemorySets, sharedSets] = await Promise.all([
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
    sharedSetsPromise,
  ]);
  const productionSkills = resolveEvolutionLayers([...sharedSets.flatMap((item) => item.skills), ...localProductionSkills], (item) => item.name);
  const productionExtensions = resolveEvolutionLayers([...sharedSets.flatMap((item) => item.extensions), ...localProductionExtensions], (item) => `${item.kind}:${item.name}`);
  const productionDeclarative = {
    prompts: resolveEvolutionLayers([...sharedSets.flatMap((item) => item.declarative.prompts), ...localProductionDeclarative.prompts], (item) => item.target),
    agentProfiles: resolveEvolutionLayers([...sharedSets.flatMap((item) => item.declarative.agentProfiles), ...localProductionDeclarative.agentProfiles], (item) => item.target),
  };
  const { memories: organizationMemories, conflicts: organizationConflicts } = resolveOrganizationMemoryConflicts(organizationMemorySets.flat());
  const productionMemories = resolveEvolutionLayers([...organizationMemories, ...sharedSets.flatMap((item) => item.memories), ...localProductionMemories], (item) => item.target);
  const canaryAssignments = await matchingCanaryAssignments(workspaceRoot, workspaceId, profile, agent, context);
  const skills = resolveEvolutionLayers([...productionSkills, ...canarySkills], (item) => item.name);
  const memories = resolveEvolutionLayers([...productionMemories, ...canaryMemories], (item) => item.target).slice(0, 20);
  const extensions = resolveEvolutionLayers([...productionExtensions, ...canaryExtensions], (item) => `${item.kind}:${item.name}`);
  const prompts = resolveEvolutionLayers([...productionDeclarative.prompts, ...canaryDeclarative.prompts], (item) => item.target);
  const agentProfiles = resolveEvolutionLayers([...productionDeclarative.agentProfiles, ...canaryDeclarative.agentProfiles], (item) => item.target);
  const resolvedReleases: RuntimeEvolutionResolvedRelease[] = [
    ...skills.map((item) => resolvedRelease("skill", item.name, item)),
    ...memories.map((item) => resolvedRelease("memory", item.target, item, item.sourceWorkspaceId)),
    ...extensions.map((item) => resolvedRelease(item.kind, item.name, item)),
    ...prompts.map((item) => resolvedRelease("prompt", item.target, item)),
    ...agentProfiles.map((item) => resolvedRelease("agent_profile", item.target, item)),
  ].sort((left, right) => `${left.assetKind}:${left.target}:${left.ownerLevel}`.localeCompare(`${right.assetKind}:${right.target}:${right.ownerLevel}`));
  const snapshotHash = hash(canonical({ workspaceId, profileId: profile.id, resolvedReleases, organizationConflicts }));
  return {
    skills,
    memories,
    plugins: extensions.filter((item) => item.kind === "plugin"),
    harnesses: extensions.filter((item) => item.kind === "harness"),
    prompts,
    agentProfiles,
    canaryReleases: [
      ...skills.filter((item) => item.stage === "canary").map((item) => ({ target: item.name, releaseId: item.releaseId, contentHash: item.contentHash })),
      ...memories.filter((item) => item.stage === "canary").map((item) => ({ target: item.target, releaseId: item.releaseId, contentHash: item.contentHash })),
      ...extensions.filter((item) => item.stage === "canary").map((item) => ({ target: item.name, releaseId: item.releaseId, contentHash: item.contentHash })),
      ...prompts.filter((item) => item.stage === "canary").map((item) => ({ target: item.target, releaseId: item.releaseId, contentHash: item.contentHash })),
      ...agentProfiles.filter((item) => item.stage === "canary").map((item) => ({ target: item.target, releaseId: item.releaseId, contentHash: item.contentHash })),
    ].sort((left, right) => left.target.localeCompare(right.target)),
    canaryAssignments,
    organizationConflicts,
    resolvedReleases,
    snapshotHash,
  };
}

function resolvedRelease(
  assetKind: RuntimeEvolutionResolvedRelease["assetKind"],
  target: string,
  item: { ownerLevel: EvolutionOwnerLevel; releaseId: string; releaseVersion: string; contentHash: string; generation: number; stage: "canary" | "production" },
  sourceWorkspaceId?: string,
): RuntimeEvolutionResolvedRelease {
  return { assetKind, target, ownerLevel: item.ownerLevel, releaseRef: { id: item.releaseId, version: item.releaseVersion, contentHash: item.contentHash }, generation: item.generation, stage: item.stage, ...(sourceWorkspaceId ? { sourceWorkspaceId } : {}) };
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
  sharedSource?: SharedEvolutionLayerSource,
): boolean {
  const sharedIdentityMatches = Boolean(sharedSource
    && pointer.scope.ownerLevel === sharedSource.ownerLevel
    && (sharedSource.ownerLevel === "company" || pointer.scope.profileId === sharedSource.ownerId));
  const identityMatches = sharedSource ? sharedIdentityMatches : pointer.scope.workspaceId === workspaceId || Boolean(
      organizationSource
      && pointer.scope.workspaceId === organizationSource.workspaceId
      && pointer.scope.organization?.id === organizationSource.organizationId
      && pointer.scope.organization.workspaceIds.includes(workspaceId),
    );
  const ownerMatches = organizationSource && pointer.scope.ownerLevel === undefined
    ? true
    : matchesEvolutionOwner(scopeOf(pointer), workspaceId, agent);
  return identityMatches && ownerMatches
    && (!pointer.scope.roles?.length || pointer.scope.roles.includes(agent.roleInWorkspace))
    && (!pointer.scope.providers?.length || pointer.scope.providers.includes(agent.provider ?? profile.defaultProvider))
    && (!pointer.scope.models?.length || pointer.scope.models.includes(agent.model ?? profile.defaultModel))
    && (!pointer.scope.taskTypes?.length || Boolean(context?.taskType && pointer.scope.taskTypes.includes(context.taskType)))
    && (!pointer.scope.tools?.length || pointer.scope.tools.every((tool) => context?.tools?.includes(tool)));
}

function scopeOf(pointer: ActiveReleasePointer): EvolutionScope { return pointer.scope; }

/** Scope ownership is independent from role/task filters; legacy releases are project-owned. */
export function matchesEvolutionOwner(scope: EvolutionScope, workspaceId: string, agent: WorkspaceAgent): boolean {
  const ownerLevel = scope.ownerLevel ?? "project";
  if (ownerLevel === "agent_project") return scope.workspaceId === workspaceId && scope.profileId === agent.profileId;
  if (ownerLevel === "agent") return scope.profileId === agent.profileId;
  if (ownerLevel === "project") return scope.workspaceId === workspaceId;
  return ownerLevel === "company";
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
function resolvedOwnerLevel(scope: EvolutionScope, legacyOrganization = false): EvolutionOwnerLevel {
  return scope.ownerLevel ?? (legacyOrganization ? "company" : "project");
}

/** Resolve behavior defaults by scope first; Canary wins only inside the same scope layer. */
export function resolveEvolutionLayers<T extends { ownerLevel: EvolutionOwnerLevel; stage: "canary" | "production"; generation: number; releaseId: string }>(
  candidates: T[],
  key: (item: T) => string,
): T[] {
  const precedence: Record<EvolutionOwnerLevel, number> = { company: 1, agent: 2, project: 3, agent_project: 4 };
  const values = new Map<string, T>();
  for (const candidate of candidates) {
    const itemKey = key(candidate); const current = values.get(itemKey);
    if (!current || precedence[candidate.ownerLevel] > precedence[current.ownerLevel]
      || (candidate.ownerLevel === current.ownerLevel && candidate.stage === "canary" && current.stage === "production")
      || (candidate.ownerLevel === current.ownerLevel && candidate.stage === current.stage && candidate.generation > current.generation)
      || (candidate.ownerLevel === current.ownerLevel && candidate.stage === current.stage && candidate.generation === current.generation && candidate.releaseId.localeCompare(current.releaseId) > 0)) {
      values.set(itemKey, candidate);
    }
  }
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
