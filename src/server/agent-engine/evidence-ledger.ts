import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { EvidenceFact } from "../../shared/contracts/agent-engine.js";

export type NewEvidenceFact = Omit<EvidenceFact, "evidenceId"> & {
  evidenceId?: string;
};

export class EvidenceLedger {
  private readonly filePath: string;
  private writeTail: Promise<void> = Promise.resolve();
  private cache?: { size: number; mtimeMs: number; facts: Map<string, EvidenceFact> };

  constructor(private readonly workspaceRoot: string) {
    this.filePath = path.join(workspaceRoot, ".autoagent", "evidence", "ledger.jsonl");
  }

  async append(input: NewEvidenceFact): Promise<EvidenceFact> {
    const fact: EvidenceFact = {
      ...structuredClone(input),
      evidenceId: input.evidenceId ?? randomUUID(),
      workspaceRoot: path.resolve(this.workspaceRoot),
    };
    const operation = this.writeTail.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `${JSON.stringify(fact)}\n`, "utf8");
      this.cache = undefined;
    });
    this.writeTail = operation.catch(() => undefined);
    await operation;
    return structuredClone(fact);
  }

  async get(evidenceId: string): Promise<EvidenceFact | undefined> {
    const facts = await this.readAll();
    const fact = facts.get(evidenceId);
    return fact ? structuredClone(fact) : undefined;
  }

  async getMany(evidenceIds: readonly string[]): Promise<Map<string, EvidenceFact>> {
    const facts = await this.readAll();
    return new Map(evidenceIds.flatMap((id) => {
      const fact = facts.get(id);
      return fact ? [[id, structuredClone(fact)] as const] : [];
    }));
  }

  private async readAll(): Promise<Map<string, EvidenceFact>> {
    await this.writeTail;
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(this.filePath);
    } catch {
      return new Map();
    }
    if (this.cache?.size === info.size && this.cache.mtimeMs === info.mtimeMs) {
      return this.cache.facts;
    }
    const content = await readFile(this.filePath, "utf8");
    const facts = new Map<string, EvidenceFact>();
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const fact = JSON.parse(line) as EvidenceFact;
      if (typeof fact.evidenceId === "string") facts.set(fact.evidenceId, fact);
    }
    this.cache = { size: info.size, mtimeMs: info.mtimeMs, facts };
    return facts;
  }
}
