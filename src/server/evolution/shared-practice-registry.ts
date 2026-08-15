import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { EvolutionPractice, EvolutionScopePromotionProposal, SharedEvolutionPracticeRecord } from "../../shared/contracts/evolution.js";
import { sharedEvolutionPracticesFile, workspaceEvolutionPracticesFile } from "../storage/paths.js";

interface LocalPracticeEvent { practice: EvolutionPractice }
interface SharedPracticeEvent { eventId: string; commandId: string; record: SharedEvolutionPracticeRecord }
const queues = new Map<string, Promise<void>>();

/** Copies the immutable learned Practice into its long-lived Agent/Company layer. */
export class SharedPracticeRegistry {
  constructor(private readonly companyId: string, private readonly layerRoot: string, private readonly now: () => Date = () => new Date()) {}

  async publish(proposal: EvolutionScopePromotionProposal, sourceRoot: string): Promise<SharedEvolutionPracticeRecord> {
    return this.exclusive(async () => {
      const existing = (await this.list()).find((record) => record.proposalId === proposal.proposalId);
      if (existing) return existing;
      const practice = await findPractice(sourceRoot, proposal);
      const record: SharedEvolutionPracticeRecord = {
        recordId: `shared_practice_${hash(proposal.proposalId).slice(0, 32)}`, companyId: this.companyId, proposalId: proposal.proposalId,
        practice: structuredClone(practice), promotedScope: structuredClone(proposal.targetScope), origin: structuredClone(proposal.origin), publishedAt: this.now().toISOString(),
      };
      const file = sharedEvolutionPracticesFile(this.layerRoot); await mkdir(path.dirname(file), { recursive: true });
      await appendFile(file, `${JSON.stringify({ eventId: randomUUID(), commandId: `publish:${proposal.proposalId}`, record })}\n`, { encoding: "utf8", mode: 0o600, flush: true });
      return record;
    });
  }

  async list(): Promise<SharedEvolutionPracticeRecord[]> {
    const records = new Map<string, SharedEvolutionPracticeRecord>();
    for (const event of await readShared(sharedEvolutionPracticesFile(this.layerRoot))) {
      if (event.record.companyId !== this.companyId) throw new Error("Shared Practice crossed its company boundary");
      records.set(event.record.recordId, event.record);
    }
    return [...records.values()].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt) || a.recordId.localeCompare(b.recordId));
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> { const key = path.resolve(sharedEvolutionPracticesFile(this.layerRoot)).toLowerCase(); const previous = queues.get(key) ?? Promise.resolve(); const pending = previous.catch(() => undefined).then(operation); const settled = pending.then(() => undefined, () => undefined); queues.set(key, settled); return pending.finally(() => { if (queues.get(key) === settled) queues.delete(key); }); }
}

async function findPractice(sourceRoot: string, proposal: EvolutionScopePromotionProposal): Promise<EvolutionPractice> {
  const local = await readLocal(workspaceEvolutionPracticesFile(sourceRoot));
  const shared = await readShared(sharedEvolutionPracticesFile(sourceRoot));
  const practice = [...local.map((event) => event.practice), ...shared.map((event) => event.record.practice)].find((item) => item.practiceId === proposal.practiceRef.id
    && String(item.version) === proposal.practiceRef.version && item.provenanceHash === proposal.practiceRef.contentHash);
  if (!practice) throw new Error(`Promoted Practice is missing from its source ledger: ${proposal.practiceRef.id}@${proposal.practiceRef.version}`);
  return practice;
}
async function readLocal(file: string): Promise<LocalPracticeEvent[]> { try { return (await readFile(file, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as LocalPracticeEvent); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; } }
async function readShared(file: string): Promise<SharedPracticeEvent[]> { try { return (await readFile(file, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as SharedPracticeEvent); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; } }
function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
