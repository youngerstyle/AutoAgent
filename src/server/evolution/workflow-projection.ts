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
    const manifest = JSON.parse(await readFile(safeResolve(workspaceRoot, path.join(".autoagent", "evolution", "releases", pointer.release.id, "manifest.json")), "utf8")) as Record<string, any>;
    if (manifest.schemaVersion !== 1 || manifest.candidateKind !== "workflow" || manifest.target !== target || manifest.promotionId !== pointer.promotionId
      || manifest.release?.id !== pointer.release.id || manifest.release?.contentHash !== pointer.release.contentHash || manifest.runtimeActive !== true || manifest.validationPassed !== true
      || !Array.isArray(manifest.validationChecks) || !manifest.validationChecks.some((check: Record<string, unknown>) => check.name === "workflow_contract" && check.passed === true)) continue;
    const content = await readFile(safeResolve(workspaceRoot, path.join(".autoagent", String(manifest.artifactRef))), "utf8");
    if (hash(content) !== manifest.candidateHash) throw new Error(`Production Workflow release ${pointer.release.id} failed content verification`);
    const artifact = JSON.parse(content) as Record<string, any>;
    if (artifact.schemaVersion !== 1 || artifact.templateId !== target || !Number.isSafeInteger(artifact.definitionVersion)) throw new Error(`Production Workflow release ${pointer.release.id} has an invalid artifact`);
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
