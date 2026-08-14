import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { ActiveReleasePointer, EvolutionRuntimeConfigArtifact } from "../../shared/contracts/evolution.js";

interface RuntimeConfigReleaseManifest {
  schemaVersion: 1;
  release: { id: string; version: string; contentHash: string };
  stage: "production";
  candidateId: string;
  candidateHash: string;
  candidateKind: "runtime_config";
  target: string;
  artifactRef: string;
  scope: ActiveReleasePointer["scope"];
  promotionId: string;
  runtimeActive: true;
  validationPassed: boolean;
  validationChecks: Array<{ name: string; passed: boolean; message: string }>;
}

export interface RuntimeEvolutionConfig {
  target: "runtime-host";
  settings: EvolutionRuntimeConfigArtifact["settings"];
  releaseId: string;
  releaseVersion: string;
  contentHash: string;
  generation: number;
}

/** Resolve the immutable production desired state once during process boot. */
export async function productionEvolutionRuntimeConfig(
  workspaceRoot: string,
  workspaceId: string,
): Promise<RuntimeEvolutionConfig | undefined> {
  const directory = path.join(workspaceRoot, ".autoagent", "evolution", "active", "production");
  let files: string[];
  try { files = (await readdir(directory)).filter((file) => file.endsWith(".json")).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const matches: RuntimeEvolutionConfig[] = [];
  for (const file of files) {
    const pointer = JSON.parse(await readFile(path.join(directory, file), "utf8")) as ActiveReleasePointer;
    if (pointer?.schemaVersion !== 1 || pointer.stage !== "production" || !pointer.active || !pointer.release
      || pointer.target !== "runtime-host" || pointer.scope.workspaceId !== workspaceId) continue;
    const manifest = parseManifest(await readFile(safeResolve(workspaceRoot, path.join(".autoagent", "evolution", "releases", pointer.release.id, "manifest.json")), "utf8"));
    if (manifest.candidateKind !== "runtime_config" || manifest.target !== pointer.target || manifest.promotionId !== pointer.promotionId
      || manifest.release.id !== pointer.release.id || manifest.release.contentHash !== pointer.release.contentHash || manifest.scope.workspaceId !== workspaceId
      || !manifest.validationPassed || !manifest.validationChecks.some((check) => check.name === "runtime_config_contract" && check.passed)) continue;
    const content = await readFile(safeResolve(workspaceRoot, path.join(".autoagent", "evolution", manifest.artifactRef)), "utf8");
    if (hash(content) !== manifest.candidateHash) throw new Error(`Production Runtime Config release ${pointer.release.id} failed content verification`);
    const artifact = parseArtifact(content);
    matches.push({
      target: "runtime-host", settings: structuredClone(artifact.settings), releaseId: pointer.release.id,
      releaseVersion: pointer.release.version, contentHash: pointer.release.contentHash, generation: pointer.generation,
    });
  }
  if (matches.length > 1) throw new Error("Multiple active production Runtime Config releases target runtime-host");
  return matches[0];
}

export function runtimeConfigSnapshotHash(config: RuntimeEvolutionConfig): string {
  return hash(canonical({ target: config.target, settings: config.settings, releaseId: config.releaseId, generation: config.generation }));
}

function parseManifest(raw: string): RuntimeConfigReleaseManifest {
  const value = JSON.parse(raw) as RuntimeConfigReleaseManifest;
  if (value?.schemaVersion !== 1 || value.stage !== "production" || value.runtimeActive !== true || !value.release || !Array.isArray(value.validationChecks)) {
    throw new Error("Invalid Runtime Config release manifest");
  }
  return value;
}

function parseArtifact(raw: string): EvolutionRuntimeConfigArtifact {
  const value = JSON.parse(raw) as EvolutionRuntimeConfigArtifact;
  if (value?.schemaVersion !== 1 || value.target !== "runtime-host" || !value.settings || typeof value.settings !== "object" || Array.isArray(value.settings)) {
    throw new Error("Invalid Runtime Config artifact");
  }
  return value;
}

function safeResolve(root: string, relative: string): string {
  const base = path.resolve(root);
  const resolved = path.resolve(base, relative);
  if (!resolved.startsWith(`${base}${path.sep}`)) throw new Error("Runtime Config release path escaped workspace root");
  return resolved;
}
function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
