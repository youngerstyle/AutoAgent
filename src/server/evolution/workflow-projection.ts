import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { ActiveReleasePointer } from "../../shared/contracts/evolution.js";
import type { PlanDefinition, PlanPolicyRef } from "../../shared/contracts/ticket-engine.js";

export interface RuntimeEvolutionWorkflow {
  target: string;
  definition: PlanDefinition;
  releaseId: string;
  releaseVersion: string;
  contentHash: string;
  generation: number;
}

interface WorkflowReleaseManifest {
  schemaVersion: 1;
  release: { id: string; version: string; contentHash: string };
  candidateHash: string;
  candidateKind: "workflow";
  target: string;
  promotionId: string;
  artifactRef: string;
  runtimeActive: true;
  validationPassed: boolean;
  validationChecks: Array<{ name: string; passed: boolean }>;
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
): Promise<RuntimeEvolutionWorkflow | undefined> {
  const directory = path.join(workspaceRoot, ".autoagent", "evolution", "active", "production");
  let files: string[];
  try { files = (await readdir(directory)).filter((file) => file.endsWith(".json")).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const matches: RuntimeEvolutionWorkflow[] = [];
  for (const file of files) {
    const pointer = JSON.parse(await readFile(path.join(directory, file), "utf8")) as ActiveReleasePointer;
    if (pointer?.schemaVersion !== 1 || pointer.stage !== "production" || !pointer.active || !pointer.release || pointer.target !== target || pointer.scope.workspaceId !== workspaceId) continue;
    const manifest = parseManifest(await readFile(safeResolve(workspaceRoot, path.join(".autoagent", "evolution", "releases", pointer.release.id, "manifest.json")), "utf8"));
    if (manifest.schemaVersion !== 1 || manifest.candidateKind !== "workflow" || manifest.target !== target || manifest.promotionId !== pointer.promotionId
      || manifest.release?.id !== pointer.release.id || manifest.release?.contentHash !== pointer.release.contentHash || manifest.runtimeActive !== true || manifest.validationPassed !== true
      || !manifest.validationChecks.some((check) => check.name === "workflow_contract" && check.passed === true)) continue;
    const content = await readFile(safeResolve(workspaceRoot, path.join(".autoagent", "evolution", manifest.artifactRef)), "utf8");
    if (hash(content) !== manifest.candidateHash) throw new Error(`Production Workflow release ${pointer.release.id} failed content verification`);
    const artifact = parseArtifact(content);
    if (artifact.templateId !== target) throw new Error(`Production Workflow release ${pointer.release.id} has an invalid target`);
    matches.push({
      target, releaseId: pointer.release.id, releaseVersion: pointer.release.version, contentHash: pointer.release.contentHash, generation: pointer.generation,
      definition: {
        definitionId: artifact.templateId, definitionVersion: artifact.definitionVersion,
        policyRef: structuredClone(policyRef), plannerAssignment: structuredClone(artifact.plannerAssignment),
        amendmentTemplate: structuredClone(artifact.amendmentTemplate), initialChange: structuredClone(artifact.initialChange),
      },
    });
  }
  if (matches.length > 1) throw new Error(`Multiple active production Workflow releases target ${target}`);
  return matches[0];
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
