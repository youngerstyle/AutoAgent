import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { EvolutionEvalCase, EvolutionEvalSuite, VersionedEvolutionRef } from "../../shared/contracts/evolution.js";
import { HttpError } from "../errors.js";
import { writeJson } from "../storage/json.js";
import { workspaceEvolutionEvalSuiteFile, workspaceEvolutionEvalSuiteIndexFile } from "../storage/paths.js";

const queues = new Map<string, Promise<void>>();
interface SuiteIndexEntry { suiteRef: VersionedEvolutionRef; createdAt: string }

export class EvolutionEvalSuiteStore {
  constructor(private readonly workspaceId: string, private readonly workspaceRoot: string, private readonly now: () => Date = () => new Date()) {}

  async create(input: { id: string; version: string; title: string; cases: EvolutionEvalCase[]; automation?: EvolutionEvalSuite["automation"] }): Promise<EvolutionEvalSuite> {
    return this.exclusive(async () => {
      validate(input, this.workspaceId);
      const body = { id: input.id, version: input.version, title: input.title, cases: input.cases, ...(input.automation ? { automation: input.automation } : {}) };
      const contentHash = hash(canonical(body));
      const entries = await readIndex(workspaceEvolutionEvalSuiteIndexFile(this.workspaceRoot));
      const version = entries.find((entry) => entry.suiteRef.id === input.id && entry.suiteRef.version === input.version);
      if (version && version.suiteRef.contentHash !== contentHash) throw new HttpError(409, "Evaluation suite version is immutable", "EVOLUTION_EVAL_SUITE_VERSION_CONFLICT");
      const file = workspaceEvolutionEvalSuiteFile(this.workspaceRoot, contentHash);
      const existing = await readOptional(file);
      if (existing) {
        const parsed = JSON.parse(existing) as EvolutionEvalSuite;
        if (hash(canonical({ id: parsed.suiteRef.id, version: parsed.suiteRef.version, title: parsed.title, cases: parsed.cases, ...(parsed.automation ? { automation: parsed.automation } : {}) })) !== contentHash) throw new Error("Evaluation suite content conflict");
        if (!version) await appendIndex(workspaceEvolutionEvalSuiteIndexFile(this.workspaceRoot), { suiteRef: parsed.suiteRef, createdAt: parsed.createdAt });
        return parsed;
      }
      const suite: EvolutionEvalSuite = {
        suiteRef: { id: input.id, version: input.version, contentHash }, title: input.title,
        cases: structuredClone(input.cases), ...(input.automation ? { automation: structuredClone(input.automation) } : {}), createdAt: this.now().toISOString(),
      };
      await writeJson(file, suite);
      await appendIndex(workspaceEvolutionEvalSuiteIndexFile(this.workspaceRoot), { suiteRef: suite.suiteRef, createdAt: suite.createdAt });
      return suite;
    });
  }

  async get(ref: VersionedEvolutionRef): Promise<EvolutionEvalSuite> {
    if (!/^[a-f0-9]{64}$/.test(ref.contentHash)) throw invalid("Evaluation suite hash is invalid");
    const raw = await readOptional(workspaceEvolutionEvalSuiteFile(this.workspaceRoot, ref.contentHash));
    if (!raw) throw new HttpError(404, "Evaluation suite not found", "EVOLUTION_EVAL_SUITE_NOT_FOUND");
    const suite = JSON.parse(raw) as EvolutionEvalSuite;
    if (suite.suiteRef.id !== ref.id || suite.suiteRef.version !== ref.version || suite.suiteRef.contentHash !== ref.contentHash) throw new Error("Evaluation suite reference conflict");
    return suite;
  }

  async list(): Promise<VersionedEvolutionRef[]> {
    return (await readIndex(workspaceEvolutionEvalSuiteIndexFile(this.workspaceRoot))).map((entry) => entry.suiteRef);
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const key = path.resolve(workspaceEvolutionEvalSuiteIndexFile(this.workspaceRoot)).toLowerCase();
    const previous = queues.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(operation);
    const settled = pending.then(() => undefined, () => undefined);
    queues.set(key, settled);
    return pending.finally(() => { if (queues.get(key) === settled) queues.delete(key); });
  }
}

function validate(input: { id: string; version: string; title: string; cases: EvolutionEvalCase[]; automation?: EvolutionEvalSuite["automation"] }, workspaceId: string): void {
  if (!input.id?.trim() || !input.version?.trim() || !input.title?.trim()) throw invalid("Evaluation suite identity is incomplete");
  if (!Array.isArray(input.cases) || input.cases.length < 3) throw invalid("Evaluation suite requires target, regression, and safety cases");
  const groups = new Set(input.cases.map((item) => item.group));
  if (!["target", "regression", "safety"].every((group) => groups.has(group as EvolutionEvalCase["group"]))) throw invalid("Evaluation suite requires all case groups");
  if (!input.cases.some((item) => item.partition === "historical") || !input.cases.some((item) => item.partition === "sealed_holdout")) throw invalid("Evaluation suite must separate historical cases from a sealed holdout");
  const ids = new Set<string>();
  for (const item of input.cases) {
    if (!item.caseId?.trim() || ids.has(item.caseId) || !["historical", "sealed_holdout"].includes(item.partition) || item.inputRef?.kind !== "evidence" || !item.inputRef.ref || item.inputRef.workspaceId !== workspaceId || !item.assertions?.length || item.assertions.some((value) => !value.trim())) throw invalid("Evaluation suite case is invalid");
    ids.add(item.caseId);
  }
  if (input.automation) {
    const value = input.automation;
    if (!value.kinds?.length || value.kinds.some((kind) => !["memory", "prompt", "skill", "workflow"].includes(kind))
      || value.targets?.some((target) => !target?.trim()) || !value.baselineRef?.id || !value.baselineRef.version || !value.baselineRef.contentHash
      || !value.runtimeSnapshotRef?.trim() || !value.policyRef?.id || !value.policyRef.version || !value.policyRef.contentHash) throw invalid("Evaluation suite automation is invalid");
  }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
async function readOptional(file: string): Promise<string | undefined> { try { return await readFile(file, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } }
async function appendIndex(file: string, entry: SuiteIndexEntry): Promise<void> { await mkdir(path.dirname(file), { recursive: true }); await appendFile(file, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600, flush: true }); }
async function readIndex(file: string): Promise<SuiteIndexEntry[]> {
  const raw = await readOptional(file); if (raw === undefined) return [];
  return raw.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      const entry = JSON.parse(line) as SuiteIndexEntry;
      if (!entry?.suiteRef?.id || !entry.suiteRef.version || !/^[a-f0-9]{64}$/.test(entry.suiteRef.contentHash)) throw new Error("invalid entry");
      return entry;
    } catch (error) { throw new Error(`Evaluation suite index is corrupt at line ${index + 1}: ${(error as Error).message}`); }
  });
}
function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function invalid(message: string): HttpError { return new HttpError(400, message, "INVALID_EVOLUTION_EVAL_SUITE"); }
