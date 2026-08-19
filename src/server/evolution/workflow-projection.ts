import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { ActiveReleasePointer, EvolutionOwnerLevel, EvolutionTrialRuntimeContext } from "../../shared/contracts/evolution.js";
import type { PlanDefinition, PlanPolicyRef } from "../../shared/contracts/ticket-engine.js";
import type { SharedEvolutionLayerSource } from "./runtime-projection.js";
import type { RuntimeEvolutionWorkflow } from "../../shared/contracts/evolution-runtime.js";
export type { RuntimeEvolutionWorkflow } from "../../shared/contracts/evolution-runtime.js";
import { isCanaryAssignment, resolveEvolutionLayers } from "./runtime-projection.js";
import { EvolutionStore } from "./evolution-store.js";

interface WorkflowReleaseManifest {
  schemaVersion: 1;
  stage: "canary" | "production";
  release: { id: string; version: string; contentHash: string };
  candidateHash: string;
  candidateKind: "workflow";
  target: string;
  promotionId: string;
  artifactRef: string;
  runtimeActive: true;
  validationPassed: boolean;
  validationChecks: Array<{ name: string; passed: boolean }>;
  scope: ActiveReleasePointer["scope"];
}
interface WorkflowArtifact {
  schemaVersion: 1;
  templateId: string;
  definitionVersion: number;
  plannerAssignment: PlanDefinition["plannerAssignment"];
  amendmentTemplate: PlanDefinition["amendmentTemplate"];
  initialChange: PlanDefinition["initialChange"];
}

export async function productionEvolutionWorkflow(
  workspaceRoot: string,
  workspaceId: string,
  target: string,
  policyRef: PlanPolicyRef,
  context: { profileId?: string; sharedReleaseSources?: SharedEvolutionLayerSource[] } = {},
): Promise<RuntimeEvolutionWorkflow | undefined> {
  const matches: Array<RuntimeEvolutionWorkflow & { stage: "production" }> = [];
  const roots = [{ root: workspaceRoot }, ...(context.sharedReleaseSources ?? []).map((item) => ({ root: item.layerRoot }))];
  for (const { root } of roots) {
    const directory = path.join(root, ".autoagent", "evolution", "active", "production");
    let files: string[];
    try { files = (await readdir(directory)).filter((file) => file.endsWith(".json")).sort(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    for (const file of files) {
      const pointer = JSON.parse(await readFile(path.join(directory, file), "utf8")) as ActiveReleasePointer;
      if (pointer?.schemaVersion !== 1 || pointer.stage !== "production" || !pointer.active || !pointer.release || pointer.target !== target || !matchesOwner(pointer, workspaceId, context.profileId)) continue;
      const workflow = await workflowFromPointer(root, pointer, target, policyRef, "production");
      if (workflow?.stage === "production") matches.push({ ...workflow, stage: "production" });
    }
  }
  return resolveEvolutionLayers(matches, (item) => item.target)[0];
}

export async function evolutionWorkflowForTask(
  workspaceRoot: string,
  workspaceId: string,
  target: string,
  policyRef: PlanPolicyRef,
  assignmentKey: string,
  context: { profileId?: string; sharedReleaseSources?: SharedEvolutionLayerSource[] } = {},
): Promise<{ workflow?: RuntimeEvolutionWorkflow; canaryAssignment?: { target: string; promotionId: string; releaseId: string; selected: boolean } }> {
  const production = await productionEvolutionWorkflow(workspaceRoot, workspaceId, target, policyRef, context);
  const directory = path.join(workspaceRoot, ".autoagent", "evolution", "active", "canary");
  let files: string[];
  try { files = (await readdir(directory)).filter((file) => file.endsWith(".json")).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return production ? { workflow: production } : {}; throw error; }
  const pointers = files.map(async (file) => JSON.parse(await readFile(path.join(directory, file), "utf8")) as ActiveReleasePointer);
  const eligible = (await Promise.all(pointers))
    .filter((pointer) => pointer?.schemaVersion === 1 && pointer.stage === "canary" && pointer.active && pointer.release && pointer.promotionId && pointer.rollout && pointer.target === target && matchesOwner(pointer, workspaceId, context.profileId))
    .sort((left, right) => ownerRank(right.scope.ownerLevel) - ownerRank(left.scope.ownerLevel) || right.generation - left.generation);
  const pointer = eligible[0];
  if (!pointer?.release || !pointer.promotionId || !pointer.rollout) return production ? { workflow: production } : {};
  const selected = isCanaryAssignment(pointer.rollout, assignmentKey);
  const canaryAssignment = { target, promotionId: pointer.promotionId, releaseId: pointer.release.id, selected };
  if (!selected) return { ...(production ? { workflow: production } : {}), canaryAssignment };
  const canary = await workflowFromPointer(workspaceRoot, pointer, target, policyRef, "canary");
  if (!canary) throw new Error("Selected Workflow Canary failed immutable release verification");
  return { workflow: canary, canaryAssignment };
}

export async function trialEvolutionWorkflow(
  workspaceRoot: string,
  workspaceId: string,
  target: string,
  policyRef: PlanPolicyRef,
  trial: EvolutionTrialRuntimeContext,
): Promise<RuntimeEvolutionWorkflow | undefined> {
  if (trial.variant === "baseline") {
    if (trial.baselineRef.id.startsWith("builtin:")) return undefined;
    const current = await productionEvolutionWorkflow(workspaceRoot, workspaceId, target, policyRef);
    if (!current || current.releaseId !== trial.baselineRef.id || current.releaseVersion !== trial.baselineRef.version || current.contentHash !== trial.baselineRef.contentHash) throw new Error("Evolution trial baseline release is no longer the frozen production revision");
    return current;
  }
  const store = new EvolutionStore(workspaceId, workspaceRoot);
  const candidate = await store.get(trial.candidateId);
  if (candidate.kind !== "workflow" || candidate.target !== target || candidate.contentHash !== trial.candidateHash || !["validated", "ready_for_eval"].includes(candidate.status)) throw new Error("Evolution trial Workflow Candidate is not the frozen validated revision");
  if (candidate.scope.workspaceId !== workspaceId) throw new Error("Evolution trial Workflow Candidate crossed its workspace scope");
  const artifact = parseArtifact(await store.artifactContent(candidate.candidateId));
  if (artifact.templateId !== target) throw new Error("Evolution trial Workflow Candidate target mismatch");
  return {
    target, releaseId: candidate.candidateId, releaseVersion: String(candidate.revision), contentHash: candidate.contentHash,
    generation: 0, stage: "trial", ownerLevel: candidate.scope.ownerLevel ?? "project", sourceRoot: workspaceRoot,
    definition: {
      definitionId: artifact.templateId, definitionVersion: artifact.definitionVersion, policyRef: structuredClone(policyRef),
      plannerAssignment: structuredClone(artifact.plannerAssignment), amendmentTemplate: structuredClone(artifact.amendmentTemplate), initialChange: structuredClone(artifact.initialChange),
    },
  };
}

function matchesOwner(pointer: ActiveReleasePointer, workspaceId: string, profileId?: string): boolean { const owner = pointer.scope.ownerLevel ?? "project"; if (owner === "company") return true; if (owner === "agent") return Boolean(profileId && pointer.scope.profileId === profileId); if (owner === "project") return pointer.scope.workspaceId === workspaceId; return pointer.scope.workspaceId === workspaceId && Boolean(profileId && pointer.scope.profileId === profileId); }
function ownerRank(owner: EvolutionOwnerLevel | undefined): number { return owner === "agent_project" ? 4 : owner === "project" ? 3 : owner === "agent" ? 2 : 1; }

async function workflowFromPointer(root: string, pointer: ActiveReleasePointer, target: string, policyRef: PlanPolicyRef, stage: "canary" | "production"): Promise<RuntimeEvolutionWorkflow | undefined> {
  if (!pointer.release || !pointer.promotionId) return undefined;
  const manifest = parseManifest(await readFile(safeResolve(root, path.join(".autoagent", "evolution", "releases", pointer.release.id, "manifest.json")), "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.stage !== stage || manifest.candidateKind !== "workflow" || manifest.target !== target || manifest.promotionId !== pointer.promotionId
    || manifest.release?.id !== pointer.release.id || manifest.release?.contentHash !== pointer.release.contentHash || manifest.runtimeActive !== true || manifest.validationPassed !== true
    || canonical(manifest.scope) !== canonical(pointer.scope) || !manifest.validationChecks.some((check) => check.name === "workflow_contract" && check.passed === true)) return undefined;
  const content = await readFile(safeResolve(root, path.join(".autoagent", "evolution", manifest.artifactRef)), "utf8");
  if (hash(content) !== manifest.candidateHash) throw new Error(`${stage} Workflow release ${pointer.release.id} failed content verification`);
  const artifact = parseArtifact(content);
  if (artifact.templateId !== target) throw new Error(`${stage} Workflow release ${pointer.release.id} has an invalid target`);
  return {
    target, releaseId: pointer.release.id, releaseVersion: pointer.release.version, contentHash: pointer.release.contentHash, generation: pointer.generation, stage, ownerLevel: pointer.scope.ownerLevel ?? "project", sourceRoot: root,
    definition: { definitionId: artifact.templateId, definitionVersion: artifact.definitionVersion, policyRef: structuredClone(policyRef), plannerAssignment: structuredClone(artifact.plannerAssignment), amendmentTemplate: structuredClone(artifact.amendmentTemplate), initialChange: structuredClone(artifact.initialChange) },
  };
}

export function workflowSnapshotHash(definition: PlanDefinition): string { return hash(canonical(definition)); }
function parseManifest(raw: string): WorkflowReleaseManifest {
  const value = JSON.parse(raw) as WorkflowReleaseManifest;
  if (value?.schemaVersion !== 1 || !value.release || !Array.isArray(value.validationChecks) || typeof value.artifactRef !== "string") throw new Error("Production Workflow release manifest is invalid");
  return value;
}
function parseArtifact(raw: string): WorkflowArtifact {
  const value = JSON.parse(raw) as WorkflowArtifact;
  if (value?.schemaVersion !== 1 || typeof value.templateId !== "string" || !Number.isSafeInteger(value.definitionVersion)
    || !value.plannerAssignment || typeof value.plannerAssignment !== "object"
    || !value.amendmentTemplate || typeof value.amendmentTemplate !== "object"
    || !value.initialChange || typeof value.initialChange !== "object") throw new Error("Production Workflow artifact is invalid");
  return value;
}
function safeResolve(root: string, relative: string): string {
  const base = path.resolve(root);
  const resolved = path.resolve(base, relative);
  if (!resolved.startsWith(`${base}${path.sep}`)) throw new Error("Workflow release path escaped workspace root");
  return resolved;
}
function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
