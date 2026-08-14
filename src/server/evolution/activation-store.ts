import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type {
  EvolutionActivationRecord,
  EvolutionCandidate,
  EvolutionInheritanceProof,
  PromotionRecord,
  VersionedEvolutionRef,
} from "../../shared/contracts/evolution.js";
import { DEFAULT_EVOLUTION_ACTIVATION_BOUNDARY } from "../../shared/contracts/evolution.js";
import { workspaceEvolutionActivationLedgerFile } from "../storage/paths.js";

type ActivationEvent =
  | { type: "activation.pointer_changed"; commandId: string; occurredAt: string; activation: EvolutionActivationRecord }
  | { type: "activation.inherited"; commandId: string; occurredAt: string; activationId: string; proof: EvolutionInheritanceProof }
  | { type: "activation.rolled_back"; commandId: string; occurredAt: string; activationId: string }
  | { type: "activation.superseded"; commandId: string; occurredAt: string; activationId: string };

interface ActivationProjection {
  activations: Map<string, EvolutionActivationRecord>;
  proofs: Map<string, EvolutionInheritanceProof>;
  commands: Map<string, ActivationEvent>;
}

const queues = new Map<string, Promise<void>>();

export class EvolutionActivationStore {
  private readonly file: string;

  constructor(private readonly workspaceRoot: string, private readonly now: () => Date = () => new Date()) {
    this.file = workspaceEvolutionActivationLedgerFile(workspaceRoot);
  }

  async list(): Promise<EvolutionActivationRecord[]> {
    return [...(await this.project()).activations.values()]
      .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt) || left.activationId.localeCompare(right.activationId));
  }

  async listProofs(activationId?: string): Promise<EvolutionInheritanceProof[]> {
    return [...(await this.project()).proofs.values()]
      .filter((proof) => !activationId || proof.activationId === activationId)
      .sort((left, right) => left.observedAt.localeCompare(right.observedAt) || left.proofId.localeCompare(right.proofId));
  }

  async recordPointerChanged(record: PromotionRecord, candidate: EvolutionCandidate, desiredGeneration: number, previousRelease?: VersionedEvolutionRef): Promise<EvolutionActivationRecord | undefined> {
    if (record.stage === "shadow") return undefined;
    const state = await this.project();
    const replay = state.commands.get(`pointer:${record.promotionId}`);
    if (replay?.type === "activation.pointer_changed") return structuredClone(state.activations.get(replay.activation.activationId));
    const activationId = stableId("activation", record.promotionId, record.toRelease.contentHash);
    const timestamp = this.now().toISOString();
    const activation: EvolutionActivationRecord = {
      activationId, promotionId: record.promotionId, candidateId: candidate.candidateId,
      assetKind: candidate.kind, target: candidate.target, stage: record.stage,
      boundary: candidate.mutationSet?.activationBoundary ?? DEFAULT_EVOLUTION_ACTIVATION_BOUNDARY[candidate.kind],
      desiredGeneration, releaseRef: structuredClone(record.toRelease),
      ...(previousRelease ? { previousRelease: structuredClone(previousRelease) } : {}),
      scope: structuredClone(candidate.scope), status: "waiting_for_activation",
      requestedAt: timestamp, pointerChangedAt: timestamp, proofCount: 0,
    };
    await this.append({ type: "activation.pointer_changed", commandId: `pointer:${record.promotionId}`, occurredAt: timestamp, activation });
    return (await this.project()).activations.get(activationId);
  }

  async observe(input: Omit<EvolutionInheritanceProof, "proofId" | "activationId" | "boundary" | "observedAt">): Promise<EvolutionInheritanceProof | undefined> {
    const state = await this.project();
    const activation = [...state.activations.values()].find((item) =>
      item.status !== "rolled_back" && item.status !== "superseded"
      && item.assetKind === input.assetKind && item.target === input.target
      && item.releaseRef.id === input.releaseRef.id && item.releaseRef.contentHash === input.releaseRef.contentHash
      && item.desiredGeneration === input.desiredGeneration);
    if (!activation) return undefined;
    const proofId = stableId("inheritance", activation.activationId, input.runtimeKind, input.runtimeRef, input.runtimeSnapshotHash);
    const existing = state.proofs.get(proofId);
    if (existing) return structuredClone(existing);
    const observedAt = this.now().toISOString();
    const proof: EvolutionInheritanceProof = {
      ...structuredClone(input), proofId, activationId: activation.activationId,
      boundary: activation.boundary, observedAt,
    };
    await this.append({ type: "activation.inherited", commandId: `inheritance:${proofId}`, occurredAt: observedAt, activationId: activation.activationId, proof });
    return (await this.project()).proofs.get(proofId);
  }

  async recordRollback(record: PromotionRecord): Promise<void> {
    if (record.stage === "shadow") return;
    return this.recordPromotionRollback(record.promotionId, `rollback:${record.promotionId}`);
  }

  async recordPromotionRollback(promotionId: string, commandId = `rollback:${promotionId}`): Promise<void> {
    const state = await this.project();
    const activation = [...state.activations.values()].find((item) => item.promotionId === promotionId);
    if (!activation) return;
    if (state.commands.has(commandId)) return;
    const occurredAt = this.now().toISOString();
    await this.append({ type: "activation.rolled_back", commandId, occurredAt, activationId: activation.activationId });
  }

  async recordSuperseded(promotionId: string): Promise<void> {
    const state = await this.project();
    const activation = [...state.activations.values()].find((item) => item.promotionId === promotionId);
    if (!activation || activation.status === "superseded") return;
    if (state.commands.has(`supersede:${promotionId}`)) return;
    const occurredAt = this.now().toISOString();
    await this.append({ type: "activation.superseded", commandId: `supersede:${promotionId}`, occurredAt, activationId: activation.activationId });
  }

  private async append(event: ActivationEvent): Promise<void> {
    const key = this.file.toLowerCase();
    const previous = queues.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(async () => {
      const state = await this.project();
      const replay = state.commands.get(event.commandId);
      if (replay) {
        if (canonical(replay) !== canonical(event)) throw new Error("Evolution activation command conflict");
        return;
      }
      await mkdir(path.dirname(this.file), { recursive: true });
      await appendFile(this.file, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600, flush: true });
    });
    const settled = pending.then(() => undefined, () => undefined);
    queues.set(key, settled);
    try { await pending; } finally { if (queues.get(key) === settled) queues.delete(key); }
  }

  private async project(): Promise<ActivationProjection> {
    const activations = new Map<string, EvolutionActivationRecord>();
    const proofs = new Map<string, EvolutionInheritanceProof>();
    const commands = new Map<string, ActivationEvent>();
    for (const event of await readEvents(this.file)) {
      const replay = commands.get(event.commandId);
      if (replay && canonical(replay) !== canonical(event)) throw new Error("Evolution activation ledger command conflict");
      commands.set(event.commandId, event);
      if (event.type === "activation.pointer_changed") {
        const existing = activations.get(event.activation.activationId);
        if (existing && canonical(existing) !== canonical(event.activation)) throw new Error("Evolution activation id conflict");
        activations.set(event.activation.activationId, structuredClone(event.activation));
      } else if (event.type === "activation.inherited") {
        const activation = activations.get(event.activationId);
        if (!activation) throw new Error("Evolution inheritance proof references a missing activation");
        const existing = proofs.get(event.proof.proofId);
        if (existing && canonical(existing) !== canonical(event.proof)) throw new Error("Evolution inheritance proof id conflict");
        if (!existing) proofs.set(event.proof.proofId, structuredClone(event.proof));
        activations.set(activation.activationId, {
          ...activation, status: "activated", firstInheritedAt: activation.firstInheritedAt ?? event.occurredAt,
          lastInheritedAt: event.occurredAt, proofCount: existing ? activation.proofCount : activation.proofCount + 1,
        });
      } else {
        const activation = activations.get(event.activationId);
        if (!activation) throw new Error("Evolution activation terminal event references a missing activation");
        activations.set(activation.activationId, event.type === "activation.rolled_back"
          ? { ...activation, status: "rolled_back", rolledBackAt: event.occurredAt }
          : { ...activation, status: "superseded", supersededAt: event.occurredAt });
      }
    }
    return { activations, proofs, commands };
  }
}

async function readEvents(file: string): Promise<ActivationEvent[]> {
  let content: string;
  try { content = await readFile(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  return content.split("\n").filter(Boolean).map((line) => JSON.parse(line) as ActivationEvent);
}
function stableId(...values: string[]): string { return createHash("sha256").update(values.join("\0"), "utf8").digest("hex"); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
