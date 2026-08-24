import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { EvidenceFact } from "../../shared/contracts/agent-engine.js";

export type NewEvidenceFact = Omit<EvidenceFact, "evidenceId"> & { evidenceId?: string };

/** Shared append-only audit ledger used by operational frameworks and Evol. */
export class EvidenceLedger {
  private readonly filePath: string;
  private writeTail: Promise<void> = Promise.resolve();
  private cache?: { size: number; mtimeMs: number; facts: Map<string, EvidenceFact> };

  constructor(private readonly workspaceRoot: string) { this.filePath = path.join(workspaceRoot, ".autoagent", "evidence", "ledger.jsonl"); }

  async append(input: NewEvidenceFact): Promise<EvidenceFact> {
    const fact: EvidenceFact = { ...structuredClone(input), evidenceId: input.evidenceId ?? randomUUID(), workspaceRoot: path.resolve(this.workspaceRoot) };
    const operation = this.writeTail.then(async () => { await mkdir(path.dirname(this.filePath), { recursive: true }); await appendFile(this.filePath, `${JSON.stringify(fact)}\n`, "utf8"); this.cache = undefined; });
    this.writeTail = operation.catch(() => undefined); await operation; return structuredClone(fact);
  }
  async get(evidenceId: string): Promise<EvidenceFact | undefined> { const fact = (await this.readAll()).get(evidenceId); return fact ? structuredClone(fact) : undefined; }
  async getMany(evidenceIds: readonly string[]): Promise<Map<string, EvidenceFact>> { const facts = await this.readAll(); return new Map(evidenceIds.flatMap((id) => facts.has(id) ? [[id, structuredClone(facts.get(id)!)] as const] : [])); }
  async list(): Promise<EvidenceFact[]> { return [...(await this.readAll()).values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.evidenceId.localeCompare(right.evidenceId)).map((fact) => structuredClone(fact)); }
  async listForGoal(input: { agentId: string; goalId: string; attemptId?: string }): Promise<EvidenceFact[]> { return [...(await this.readAll()).values()].filter((fact) => fact.agentId === input.agentId && fact.goalId === input.goalId).filter((fact) => !input.attemptId || fact.attemptId === input.attemptId).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.evidenceId.localeCompare(right.evidenceId)).map((fact) => structuredClone(fact)); }
  private async readAll(): Promise<Map<string, EvidenceFact>> {
    await this.writeTail; let info: Awaited<ReturnType<typeof stat>>; try { info = await stat(this.filePath); } catch { return new Map(); }
    if (this.cache?.size === info.size && this.cache.mtimeMs === info.mtimeMs) return this.cache.facts;
    const facts = new Map<string, EvidenceFact>(); for (const line of (await readFile(this.filePath, "utf8")).split(/\r?\n/)) { if (!line.trim()) continue; const fact = JSON.parse(line) as EvidenceFact; if (typeof fact.evidenceId === "string") facts.set(fact.evidenceId, fact); }
    this.cache = { size: info.size, mtimeMs: info.mtimeMs, facts }; return facts;
  }
}
